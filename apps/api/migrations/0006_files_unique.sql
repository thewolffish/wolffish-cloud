-- wfc-master 0006 — one file row per (user, sha256, name).
--
-- The upload route used to INSERT unconditionally, so every re-upload of a
-- path (and every client restart that re-swept it) grew the table and pushed
-- older DISTINCT paths past the manifest's read window — files silently
-- stopped restoring at scale. Rows become upserts keyed on the triple; the
-- newest write bumps created_at so "newest row per path" stays the restore
-- rule. Existing duplicates collapse to their newest row first so the unique
-- index can build.
DELETE FROM files WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM files GROUP BY user_id, sha256, name
);
CREATE UNIQUE INDEX idx_files_user_sha_name ON files(user_id, sha256, name);
