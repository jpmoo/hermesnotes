-- Remember what a calendar feed last reported for a synced event, so mirroring
-- the feed into the block can tell a real feed change from the user's own edit
-- and never overwrite what the user wrote. Null means "no baseline yet": the
-- next fetch adopts the feed's current values as the baseline and leaves the
-- block's properties alone.
ALTER TABLE calendar_converted ADD COLUMN IF NOT EXISTS last_feed jsonb;
