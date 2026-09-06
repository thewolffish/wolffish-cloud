-- wfc-master 0019 — who someone is, and what they may reach.
--
-- Two gaps that showed up the moment anyone asked a question about an org
-- larger than a list of names.
--
-- TEAMS. Every admin view was org-wide or one person: "show me marketing's
-- spend" and "the team lead sees their own team" had nowhere to hang. One
-- column, because that is what the questions actually need — a person is in
-- a team, and rollups group by it. Nesting can come later without moving
-- anything that exists.
--
-- CAPABILITY GRANTS. The registry had exactly two scopes: 'org' (materialized
-- on EVERY device) and 'user' (yourself). There was no way to give a
-- capability to a role or a named group — even though model policy has
-- carried per-user allowlists since day one. A capability with no grants is
-- open to the whole org, which is what every existing row means today, so
-- this table starts empty and changes nothing until an admin uses it.

ALTER TABLE users ADD COLUMN team TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_users_team ON users(team) WHERE team != '';

CREATE TABLE capability_grants (
  slug TEXT NOT NULL,
  -- Who the grant names. 'role' matches users.role, 'team' matches
  -- users.team, 'user' matches users.id.
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('role', 'team', 'user')),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (slug, subject_kind, subject)
);
CREATE INDEX idx_capability_grants_slug ON capability_grants(slug);
