-- wfc-master 0008 — the web-search lane.
--
-- Web search joins the model lane as an org-provided service: one Brave
-- key behind the choke point, never on a device. The org row carries the
-- switch and the two caps (per-user daily, org monthly — in QUERIES, 0 =
-- unlimited, same convention as the token caps); a per-user override
-- rides model_policies like the token cap does (NULL = org default).
--
-- Usage rows learn their lane: 'chat' for model calls (every row so far),
-- 'search' for a metered query. A search row has no tokens; its cost is
-- the plan price per query, and its `model` names the upstream
-- ('brave/web-search') so every existing per-model aggregate still works.
ALTER TABLE org ADD COLUMN search_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE org ADD COLUMN user_daily_search_cap INTEGER NOT NULL DEFAULT 200;
ALTER TABLE org ADD COLUMN org_monthly_search_cap INTEGER NOT NULL DEFAULT 100000;

ALTER TABLE model_policies ADD COLUMN daily_search_cap INTEGER;

ALTER TABLE usage ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
CREATE INDEX idx_usage_kind_time ON usage(kind, created_at);
