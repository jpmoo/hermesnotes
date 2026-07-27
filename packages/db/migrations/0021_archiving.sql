-- Block archiving. Archived blocks are hidden from every normal query and only
-- shown on the Archive page; unarchiving (clearing the column) restores them
-- everywhere they were, since memberships/positions are untouched.
ALTER TABLE blocks ADD COLUMN archived_at timestamptz;

-- Most queries want active blocks; a partial index keeps that fast and small.
CREATE INDEX blocks_owner_active ON blocks (owner_id) WHERE archived_at IS NULL;
-- The Archive page scans the archived rows for one owner.
CREATE INDEX blocks_owner_archived ON blocks (owner_id, archived_at) WHERE archived_at IS NOT NULL;

-- Per-user auto-archive: completed tasks are archived this many days after they
-- were marked done. Null/0 = off.
ALTER TABLE user_settings ADD COLUMN autoarchive_done_days integer;
