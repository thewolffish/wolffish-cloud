-- 0003 — richer self-service profile: position (job title) and bio.
ALTER TABLE users ADD COLUMN position TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
