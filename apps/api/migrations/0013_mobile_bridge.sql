-- wfc-master 0013 — the phone pairs with the org, not with a relay.
--
-- Two additions:
--
--   pairings                 A desktop offers a pairing (an 8-character code
--                            for typing, a 32-byte token for the QR); the
--                            phone claims it and receives a device session
--                            for the same user. Single-use and short-lived,
--                            kept in D1 (not KV) so a claim is dead at once,
--                            everywhere — the same reason password_resets
--                            moved here. Only hashes are stored.
--
--   conversations.synced_at  The SERVER's clock on every conversation row
--                            write, so a phone can ask "what changed since I
--                            last looked" against one monotonic stamp. The
--                            client's updated_at cannot serve: a conversation
--                            the desktop pushes late (created offline hours
--                            earlier) carries an old updated_at and would
--                            never reach a phone whose cursor had moved on.
CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  desktop_device_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_device_id TEXT
);
CREATE INDEX idx_pairings_code ON pairings(code_hash);
CREATE INDEX idx_pairings_token ON pairings(token_hash);
CREATE INDEX idx_pairings_user ON pairings(user_id, created_at);

ALTER TABLE conversations ADD COLUMN synced_at TEXT;
-- Existing rows take their client stamp: a one-time approximation that lets
-- a phone's first pull walk them in a stable order.
UPDATE conversations SET synced_at = updated_at WHERE synced_at IS NULL;
CREATE INDEX idx_conversations_synced ON conversations(user_id, synced_at);
