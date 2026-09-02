-- Profile photo: content-addressed blob in R2 (files/<sha256>, shared with
-- the sync file store), referenced from the user row. Mime rides along so
-- the serving route needs no sniffing.
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE users ADD COLUMN avatar_mime TEXT;
