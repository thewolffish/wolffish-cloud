-- 0002 — self-service profile: a phone number on the user row.
-- Optional, free-format-but-bounded; the desktop's profile card edits it.
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
