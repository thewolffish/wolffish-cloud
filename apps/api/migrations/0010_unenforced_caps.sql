-- wfc-master 0010 — caps unenforced by default.
--
-- This repository is the demo-and-fork baseline: quotas are a mechanism a
-- fork may switch on, not a policy the baseline imposes. 0 means unlimited
-- for the org caps; NULL means "org default" for a per-user policy. The
-- enforcement path stays exactly as it is (the smoke suites still set a
-- cap, watch it trip, and lift it) — only the defaults change.
UPDATE org SET
  user_daily_token_cap = 0,
  org_monthly_token_cap = 0,
  user_daily_search_cap = 0,
  org_monthly_search_cap = 0;
UPDATE model_policies SET daily_token_cap = NULL, daily_search_cap = NULL;
