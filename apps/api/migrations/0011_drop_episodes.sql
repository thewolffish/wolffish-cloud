-- wfc-master 0011 — retire the episodes scaffolding.
--
-- The desktop never sent an `episode` item (the hippocampus episodes are
-- markdown files under brain/, synced as blobs) and nothing ever read the
-- table back; its only rows came from the smoke scripts. The batch endpoint
-- no longer accepts the item type.
DROP TABLE IF EXISTS episodes;
