-- wfc-master 0015 — the org leaderboard's one missing column.
--
-- The board's three figures are token spend, conversations and agentic
-- tasks. The first two are already cheap aggregates (usage_daily, and a
-- COUNT over conversations); the third was not countable at all, because
-- what makes a conversation "agentic" — the channel that started it — lived
-- only inside the client's snapshot envelope, as JSON, one blob per
-- conversation. Counting it meant json_extract over every snapshot row on
-- every read.
--
-- So the channel is denormalized onto the conversation row itself, written
-- by the sync ingest from the batch item (see routes/sync.ts). It is
-- immutable per conversation — provenance never changes — so there is
-- nothing to keep in step afterwards.
--
-- '' means unknown, which is what every row synced before this migration
-- would be; the backfill below reads it out of the snapshot envelopes
-- still in D1 (one pass, at migration time, instead of on every read).
-- A conversation already archived to R2 keeps '' and counts as non-agentic.
ALTER TABLE conversations ADD COLUMN channel TEXT NOT NULL DEFAULT '';

-- The board's agentic count and per-user conversation count read this.
CREATE INDEX idx_conversations_user_channel ON conversations(user_id, channel)
  WHERE deleted_at IS NULL;

UPDATE conversations SET channel = COALESCE(
  (SELECT json_extract(r.content, '$.channel')
     FROM conversation_records r
    WHERE r.conversation_id = conversations.id AND r.kind = 'snapshot'
    LIMIT 1),
  ''
) WHERE channel = '';
