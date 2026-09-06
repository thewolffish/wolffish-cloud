-- wfc-master 0020 — the index three hot paths were missing.
--
-- `files` carried (user_id, created_at), (sha256) and a unique
-- (user_id, sha256, name). Nothing served a lookup BY PATH — and three
-- paths need one on every call:
--
--   · the supersede step of every upload
--     (UPDATE files SET deleted_at … WHERE user_id = ? AND name = ?)
--   · the phone's /v1/files/path, on every media open
--   · /v1/files/delete, per chunk
--
-- Each was a scan of that user's whole file table. A workspace with ten
-- thousand files made every single upload a ten-thousand-row scan, and the
-- upload path is the one the desktop's sweep walks after every drain.
--
-- created_at DESC because every one of those reads wants the NEWEST live row
-- for a path — the index answers the ORDER BY as well as the WHERE.

CREATE INDEX idx_files_user_name ON files(user_id, name, created_at DESC);
