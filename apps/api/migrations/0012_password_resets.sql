-- wfc-master 0012 — password-reset codes move from KV to D1.
--
-- A reset code must be single-use. KV is eventually consistent: a code
-- deleted the moment it was used could still be read back — and accepted
-- again with a different new password — for up to a minute at the edge
-- (the release gate's "code dead after use" check tripped on exactly this).
-- D1 is strongly consistent, so one row per user with the attempt counter
-- and expiry makes reuse impossible. The code is stored plain, as it was in
-- KV: ten minutes, single purpose, five tries, and the audited admin read
-- (ADMIN_RESET_CODE_READ) needs it to prove the e-mailed flow.
CREATE TABLE password_resets (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  code TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
