-- Meeting Package MANAGEMENT — soft-delete support.
--
-- Once a package exists / has been shared, the curator must be able to manage
-- it: unshare (published -> draft), delete, and (for audience='list') revoke or
-- restore individual recipients. Per the project's "revoke != delete" moat we
-- NEVER hard-delete: a deleted package keeps its rows + R2 blobs for provenance
-- (the AI knowledge graph). Deletion is recorded as a timestamp; every read /
-- list filters `deleted_at IS NULL` so a deleted package vanishes from the UI
-- while its history survives. Restore simply clears the column again.
--
-- Recipient revoke/restore needs NO schema change — it flips
-- meeting_package_recipient.status ('active' <-> 'revoked'), which already
-- exists in 0032 and is honoured by canSeePackage / the list queries.
--
-- SQLite ALTER TABLE ADD COLUMN is supported (additive, nullable).

ALTER TABLE meeting_package ADD COLUMN deleted_at INTEGER;
