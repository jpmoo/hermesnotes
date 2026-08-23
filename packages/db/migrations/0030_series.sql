-- Recurrence becomes an object, not a field.
--
-- A rule has lived on the block since the beginning, and every occurrence is a
-- copy of it. That single decision is behind three separate bugs fixed this
-- week. `n`, the occurrence counter, is instance state riding on a rule, so
-- every site that copies the rule has to nurse it. `monthDay` had to be stamped
-- onto a copy and propagated forward. And the clamped-month bug happened because
-- the rule travelled *with* the instance, so "the 31st" was read off whichever
-- occurrence was in hand — and once February had clamped one, the answer was the
-- 28th forever.
--
-- One rule, one row, and the occurrences point at it. Editing it is one write.
-- Divergence between occurrence three and occurrence five stops being
-- expressible. "After N times" is counted rather than carried.
--
-- A table rather than a block, deliberately. A series is machinery, not
-- knowledge: as a block it would appear in search, carry an embedding, and write
-- a row to the change log every time an occurrence advanced.
--
-- Nothing is backfilled here. Working out which of a user's existing blocks
-- belong to the same series needs their type's schema to find the recurrence
-- field at all, which is not something to do in SQL — `pnpm series:backfill`
-- does it, reports what it will do before doing it, and can be run twice.
CREATE TABLE series (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The rule, in the shape recurrenceSchema parses. Without `n`: an occurrence
  -- count is a fact about the instances, and the instances are countable.
  rule       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX series_owner ON series (owner_id);

-- Null for everything that does not recur, which is almost everything.
-- ON DELETE SET NULL rather than CASCADE: deleting the rule that governs a
-- repeating task must not delete the work itself.
ALTER TABLE blocks ADD COLUMN series_id uuid REFERENCES series(id) ON DELETE SET NULL;

CREATE INDEX blocks_series ON blocks (series_id) WHERE series_id IS NOT NULL;
