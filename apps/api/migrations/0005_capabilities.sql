-- wfc-master 0005 — the capability registry.
--
-- Capabilities (SKILL.md + optional plugin, zipped) are cloud-first: the
-- bucket is the source of truth, clients are mirrors. One row per
-- (scope, owner, slug) holding the LATEST version; every uploaded version
-- stays in R2 under capabilities/<scope-path>/<slug>/v<version>.zip so a
-- rollback is a re-upload away.
--
-- scope 'org'  — the official set every client materializes; only
--                owner/admin may mutate (enforced in code, audited).
-- scope 'user' — a member's own imports; visible to and mutable by that
--                user alone, synced across their devices.
--
-- Removal is a tombstone (deleted_at): the row must survive so version
-- numbers keep climbing if the slug returns, and so a listing can show
-- what was retired. Clients treat "absent from the manifest" as remove.

CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'user')),
  -- '' for org scope (SQLite UNIQUE treats NULLs as distinct, '' keeps the
  -- one-row-per-slug guarantee real).
  owner_user_id TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  -- SHA-256 of the current version's zip package (integrity + client diff).
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (scope, owner_user_id, slug)
);
CREATE INDEX idx_capabilities_scope ON capabilities(scope, owner_user_id);

-- Superseded scaffolding: never wired to a route, no rows ever written.
DROP TABLE skills;
