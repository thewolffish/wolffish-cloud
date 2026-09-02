-- wfc-master 0009 — the 500-employee scale pass.
--
-- Three additions, no behaviour change for existing rows:
--
--   usage.upstream        which model host served a call (the router now runs
--                         a pool of upstreams; cost per host must be reportable).
--   usage_daily           the per-user, per-day, per-lane rollup the meter keeps
--                         in the same D1 batch as the raw row. Admin totals read
--                         this instead of scanning a month of raw rows, and the
--                         totals survive the raw-row retention sweep.
--   conversations.archived_at / archive_key
--                         a conversation idle for the archive window has its
--                         records moved to one gzipped blob in R2 (the nightly
--                         job); the records read merges the blob with any rows
--                         that arrived since. D1 stays a bounded hot window.
ALTER TABLE usage ADD COLUMN upstream TEXT NOT NULL DEFAULT '';

CREATE TABLE usage_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,            -- YYYY-MM-DD, UTC
  kind TEXT NOT NULL,           -- 'chat' | 'search'
  requests INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);
CREATE INDEX idx_usage_daily_day ON usage_daily(day);

ALTER TABLE conversations ADD COLUMN archived_at TEXT;
ALTER TABLE conversations ADD COLUMN archive_key TEXT;
CREATE INDEX idx_conversations_idle ON conversations(updated_at)
  WHERE deleted_at IS NULL;
