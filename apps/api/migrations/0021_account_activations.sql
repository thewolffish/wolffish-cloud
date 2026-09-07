-- wfc-master 0021 — invited accounts are activated by an emailed code.
--
-- Adding a person used to mint a temp password that the API handed back to
-- the admin to convey by hand: the credential travelled over whatever the
-- admin happened to use, and nothing ever proved the address was real. An
-- invite now sends a 6-digit code to the address itself, and the person
-- turns that code into their own password — so the mailbox is the proof of
-- identity and no shared secret passes through a third person.
--
-- Same shape and same reasoning as password_resets (0012): one row per
-- user, D1 rather than KV because a used code must be dead everywhere at
-- once, plain text because it is short-lived, single-purpose and attempt-
-- capped. Longer window than a reset (7 days, matching how long an invite
-- has always been good for) and 10 tries rather than 5, because a code that
-- has to survive a weekend gets typed in more than once.
CREATE TABLE account_activations (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  code TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
