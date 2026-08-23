-- A change to a membership or a tag is an *update* to its block, never a delete.
--
-- 0027 says as much in its own header: a child row has no owner of its own, so
-- a change to one is recorded against the block, and everything in the log
-- means "this block is not what you last saw". The function then wrote
-- lower(TG_OP) for every table alike, so deleting a child row logged op
-- 'delete' against a block that was still very much there.
--
-- Nothing removes a membership more often than moving a card, and a matrix move
-- is a delete followed by an insert. Both readers of this log treat a delete as
-- final and let it outrank anything that arrives after it — reasonably, since a
-- block that has gone is not a block to refetch — so a dragged card was
-- announced as deleted and the insert that put it back was discarded for
-- arriving second. The live watcher told every open tab the block was gone;
-- Talaria's mirror deleted it outright and only got it back on a full walk.
--
-- Only the blocks table knows a block has gone. Everything hanging off it can
-- say one thing: this block changed.
CREATE OR REPLACE FUNCTION log_change() RETURNS trigger AS $$
DECLARE
  bid uuid;
  own uuid;
  ver integer;
BEGIN
  -- The two branches are kept apart on purpose. A version only exists on a
  -- block, and plpgsql resolves a field on NEW wherever it appears in the
  -- statement — including a branch of a CASE that can't be taken — so reading
  -- NEW.version anywhere the trigger might be a membership or a tag row raises
  -- "record new has no field version" and takes the write down with it.
  IF TG_TABLE_NAME = 'blocks' THEN
    IF TG_OP = 'DELETE' THEN
      bid := OLD.id;
      own := OLD.owner_id;
    ELSE
      bid := NEW.id;
      own := NEW.owner_id;
      ver := NEW.version;
    END IF;
  ELSE
    -- TG_ARGV[0] names the column holding the block id, so one function serves
    -- every table that hangs off blocks.
    bid := CASE TG_OP
             WHEN 'DELETE' THEN (to_jsonb(OLD) ->> TG_ARGV[0])::uuid
             ELSE (to_jsonb(NEW) ->> TG_ARGV[0])::uuid
           END;
    SELECT b.owner_id INTO own FROM blocks b WHERE b.id = bid;
  END IF;

  -- Deleting a block deletes its memberships and tags with it, and by the time
  -- those fire the block is already gone. The block's own row says everything
  -- there is to say about that, so a child with no owner left to find is passed
  -- over rather than logged against nobody.
  IF own IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO changes (owner_id, block_id, op, version)
  VALUES (
    own,
    bid,
    CASE WHEN TG_TABLE_NAME = 'blocks' THEN lower(TG_OP) ELSE 'update' END,
    ver
  );
  RETURN NULL; -- AFTER trigger: the return value is discarded
END;
$$ LANGUAGE plpgsql;
