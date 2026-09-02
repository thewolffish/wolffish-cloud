-- wfc-master 0007 — usage rows carry the prompt-cache split, and the
-- per-user usage read (GET /v1/usage) walks rows by (user, id).
--
-- The desktop's usage ledger is rebuilt from this table after a purge and
-- reconciled across a user's devices, so the row must hold everything a
-- ledger line shows: upstream reports cached prompt tokens separately
-- (prompt_tokens_details.cached_tokens) and the ledger prints them as cr:N.
ALTER TABLE usage ADD COLUMN tokens_cached INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_usage_user_id ON usage(user_id, id);
