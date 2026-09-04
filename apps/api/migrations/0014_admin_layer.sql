-- wfc-master 0014 — the admin layer.
--
-- Three additions, all additive to behaviour that already works:
--
--   model_policies.token_plan
--     The employee's token PLAN — the product-level ceiling from the pricing
--     model, as opposed to the fine-grained daily cap that already lives in
--     this table. NULL means the org default ('standard'), so every existing
--     row keeps working and nobody has to be migrated onto a plan. The three
--     plans and their monthly ceilings live in src/lib/plans.ts; only the
--     name is stored, so a change to a ceiling is a code change, not a
--     backfill of five hundred rows.
--
--   usage.surface
--     WHICH SURFACE spent the tokens: the desktop app, the paired phone, the
--     browser extension, the heartbeat, a procedure. The router previously
--     recorded only the device, and a phone's turns run on the employee's
--     desktop device — so mobile spend was indistinguishable from in-app
--     spend, and extension spend was invisible. The client names its surface
--     in a header; '' is every row written before this migration.
--
--   usage_daily, rebuilt with surface in the key
--     The rollup admin totals read. Surface has to be part of the primary
--     key or the per-surface split could only be answered by scanning raw
--     rows — which the retention sweep deletes. Rebuilt rather than
--     ALTER-ed because SQLite cannot extend a primary key in place; the copy
--     preserves every existing day under surface '' so history survives.
ALTER TABLE model_policies ADD COLUMN token_plan TEXT;

ALTER TABLE usage ADD COLUMN surface TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_usage_user_surface ON usage(user_id, surface, created_at);

CREATE TABLE usage_daily_v2 (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,            -- YYYY-MM-DD, UTC
  kind TEXT NOT NULL,           -- 'chat' | 'search'
  surface TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind, surface)
);

INSERT INTO usage_daily_v2
  (user_id, day, kind, surface, requests, denied, tokens_in, tokens_out, tokens_cached, cost_microusd)
SELECT user_id, day, kind, '', requests, denied, tokens_in, tokens_out, tokens_cached, cost_microusd
FROM usage_daily;

DROP TABLE usage_daily;
ALTER TABLE usage_daily_v2 RENAME TO usage_daily;

CREATE INDEX idx_usage_daily_day ON usage_daily(day);
CREATE INDEX idx_usage_daily_user_day ON usage_daily(user_id, day);
