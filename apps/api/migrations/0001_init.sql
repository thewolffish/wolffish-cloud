-- wfc-master 0001 — the single-org master record.
--
-- Wolffish Cloud is deliberately single-org: tenancy lives at the fork /
-- deployment layer, so there is no org_id anywhere. The one `org` row holds
-- what a per-org row would have held. Records the clients sync carry
-- client-generated ids so ingest is idempotent (replays are no-ops).
--
-- Roles are a fixed enum enforced here and mapped to permissions in code.
-- Passwords are PBKDF2 hashes (per-user salt); PINs never reach the server
-- (devices carry only a pin_set flag and a pending clear request).

-- ── The org (exactly one row) ────────────────────────────────────────────
CREATE TABLE org (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  default_model TEXT NOT NULL,
  -- JSON array of DeepInfra model ids every employee may use unless
  -- overridden per-user in model_policies.
  default_allowed_models TEXT NOT NULL DEFAULT '[]',
  -- Caps in tokens. user_daily applies per user; org_monthly is global.
  user_daily_token_cap INTEGER NOT NULL DEFAULT 2000000,
  org_monthly_token_cap INTEGER NOT NULL DEFAULT 500000000,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ── People ───────────────────────────────────────────────────────────────
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'support', 'employee')),
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  temp_password_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);

-- ── Devices & sessions ───────────────────────────────────────────────────
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK (platform IN ('desktop', 'mobile', 'sim')),
  name TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  pin_set INTEGER NOT NULL DEFAULT 0,
  pin_clear_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT
);
CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  -- SHA-256 of the current refresh token; rotates on every refresh.
  refresh_hash TEXT NOT NULL,
  -- Incremented per rotation; a presented token whose generation is stale
  -- means reuse (possible theft) and kills the session.
  refresh_generation INTEGER NOT NULL DEFAULT 1,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  refreshed_at TEXT,
  -- Idle expiry, extended on refresh. Cron sweeps expired rows.
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX idx_sessions_user ON device_sessions(user_id);
CREATE INDEX idx_sessions_device ON device_sessions(device_id);
CREATE INDEX idx_sessions_expiry ON device_sessions(expires_at) WHERE revoked_at IS NULL;

-- ── Model governance ─────────────────────────────────────────────────────
CREATE TABLE model_policies (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  -- JSON array of allowed model ids; NULL/absent row means org defaults.
  allowed_models TEXT,
  -- NULL means org default cap.
  daily_token_cap INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  device_id TEXT,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  decision TEXT NOT NULL
    CHECK (decision IN ('allowed', 'denied_model', 'denied_quota', 'error')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_usage_user_time ON usage(user_id, created_at);
CREATE INDEX idx_usage_time ON usage(created_at);

-- ── Synced state (the master record) ─────────────────────────────────────
-- Per-user config blob; the desktop's config.json becomes this row.
CREATE TABLE settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  config TEXT NOT NULL DEFAULT '{}',
  -- Server timestamp wins on admin-authored writes (last-write-wins).
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, -- client-generated
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at);

CREATE TABLE conversation_records (
  id TEXT PRIMARY KEY, -- client-generated; replays are no-ops
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  content TEXT NOT NULL, -- JSON payload, shape owned by the client
  created_at TEXT NOT NULL
);
CREATE INDEX idx_records_conversation ON conversation_records(conversation_id, seq);

-- The agent's memory stream (hippocampus episodes), append-only.
CREATE TABLE episodes (
  id TEXT PRIMARY KEY, -- client-generated
  user_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL, -- JSON payload
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_episodes_user ON episodes(user_id, occurred_at);

-- File metadata; blobs live in R2 content-addressed as files/<sha256>.
CREATE TABLE files (
  id TEXT PRIMARY KEY, -- client-generated
  user_id TEXT NOT NULL REFERENCES users(id),
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_files_user ON files(user_id, created_at);
CREATE INDEX idx_files_hash ON files(sha256);

-- Versioned skill catalog; content blobs in R2 as skills/<sha256>.
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ── Audit ────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_audit_time ON audit_log(created_at);
