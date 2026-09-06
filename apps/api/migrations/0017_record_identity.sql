-- wfc-master 0017 — the record's identity, as columns.
--
-- A message record's id has always been `<messageId>.<first 8 of a content
-- hash>`: one string carrying two facts, so "which message is this" and
-- "which version is this" were recovered by parsing it — in FOUR places, by
-- three different mechanisms (a regex in the desktop's restore, a regex in
-- the phone's rebuild, and `substr(r.id, 1, length(r.id) - 9)` in two SQL
-- queries here). The convention was load-bearing inside SQL, and a message
-- whose own id happened to end in a dot and eight hex characters would have
-- been silently mis-grouped.
--
-- Both facts become columns. Clients send them; a client that does not (an
-- older build) has them derived server-side at insert, in the ONE parser
-- that survives. Nothing has to parse an id ever again.
--
-- base_id is NULL for snapshot rows: the envelope has no message identity,
-- and every read that groups by base_id counts messages only.

ALTER TABLE conversation_records ADD COLUMN base_id TEXT;
ALTER TABLE conversation_records ADD COLUMN version_hash TEXT;

-- Backfill with the expression the reads used to carry, applied once here
-- rather than on every query for the life of the table.
UPDATE conversation_records
   SET base_id = CASE
         WHEN kind = 'message' AND length(id) > 9 AND substr(id, length(id) - 8, 1) = '.'
           THEN substr(id, 1, length(id) - 9)
         WHEN kind = 'message' THEN id
         ELSE NULL
       END,
       version_hash = CASE
         WHEN kind = 'message' AND length(id) > 9 AND substr(id, length(id) - 8, 1) = '.'
           THEN substr(id, length(id) - 7)
         ELSE NULL
       END
 WHERE base_id IS NULL;

-- The message-count reads group by (conversation, base_id); without this
-- they walk every record row of the conversation to do it.
CREATE INDEX idx_records_base ON conversation_records(conversation_id, base_id);
