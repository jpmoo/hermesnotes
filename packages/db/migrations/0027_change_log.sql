-- A record of every block that changed, written by the database itself.
--
-- Live sync used to be worked out from the shape of the HTTP request that had
-- just succeeded: a hook matched the URL against a few patterns and announced
-- the id it found there. That only ever saw writes it could recognise from the
-- outside, which left two holes. Writes made during a GET were invisible —
-- re-seeding a day's note, backfilling a title, sweeping empty notes away, the
-- calendar mirroring a feed onto a converted event. So were writes whose URL
-- didn't match the patterns: sending text to particular days, taking it back
-- out, resetting a day, rearranging one, renaming a tag, and turning a
-- placeholder into a real block — which rewrites every note that named it, and
-- had to hand the ids back so the calling tab could announce them on its own
-- behalf, leaving every other tab and device none the wiser.
--
-- A trigger sees all of it, because it sees the write rather than the request.
--
-- One line per block per write. Membership and tag rows have no owner of their
-- own and belong to a block, so a change to one is recorded as a change to that
-- block: everything here means "this block is not what you last saw", which is
-- exactly what the surfaces reading it already know how to act on.
CREATE TABLE changes (
  seq        bigserial PRIMARY KEY,
  -- Deliberately no foreign key: deleting a user would take the record of their
  -- deletions with it, which is the one moment the record matters most.
  owner_id   uuid        NOT NULL,
  block_id   uuid        NOT NULL,
  op         text        NOT NULL,
  -- The block's version after the write, so a client can tell an echo of its own
  -- save from news. Null on a delete, and on a change to a membership or tag.
  version    integer,
  at         timestamptz NOT NULL DEFAULT now()
);

-- Every read is "what has this user changed since seq N".
CREATE INDEX changes_owner_seq ON changes (owner_id, seq);
-- Pruning reads by age.
CREATE INDEX changes_at ON changes (at);

CREATE FUNCTION log_change() RETURNS trigger AS $$
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
  VALUES (own, bid, lower(TG_OP), ver);
  RETURN NULL; -- AFTER trigger: the return value is discarded
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blocks_log_change
  AFTER INSERT OR UPDATE OR DELETE ON blocks
  FOR EACH ROW EXECUTE FUNCTION log_change();

CREATE TRIGGER memberships_log_change
  AFTER INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION log_change('block_id');

CREATE TRIGGER block_tags_log_change
  AFTER INSERT OR UPDATE OR DELETE ON block_tags
  FOR EACH ROW EXECUTE FUNCTION log_change('block_id');
