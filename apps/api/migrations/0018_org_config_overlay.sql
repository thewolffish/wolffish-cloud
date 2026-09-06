-- wfc-master 0018 — org control over what the agent DOES, not just what it spends.
--
-- Every control this platform had was financial: the model allowlist, the
-- token caps, the plans, the search switch. Everything about how the agent
-- BEHAVES lived in the per-user `settings` blob, which an admin could only
-- replace wholesale — so "nobody may enable the shell capability", "everyone
-- uses this heartbeat", "MCP servers are restricted to this list" had no
-- expression at all, and the one available move (overwrite the whole row)
-- also discarded every preference the employee owned.
--
-- The overlay is the seam. One JSON object of dot-path → value, applied
-- OVER the user's own config on read and forced on write, so the org's value
-- wins wherever it has an opinion and the employee keeps every path the org
-- has not claimed. Paths present in the overlay ARE the locked set — one
-- concept, so a lock and its value can never drift apart.
--
-- Deliberately not merged into `org`: that row is read on the model hot path
-- and cached at the edge for it, and this belongs to the config path only.

CREATE TABLE org_config_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- {"dot.path": value, …} — every path here is org-owned.
  overlay TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT NOT NULL DEFAULT ''
);
INSERT INTO org_config_policy (id, overlay) VALUES (1, '{}');
