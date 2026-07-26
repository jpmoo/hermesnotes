-- Calendar "sync" links: a converted feed event stays tied to its Hermes block.
-- When that block is deleted, the tracking row must go with it so the source
-- event reappears in the feed. Switch the block_id FK from SET NULL to CASCADE.
ALTER TABLE calendar_converted DROP CONSTRAINT IF EXISTS calendar_converted_block_id_fkey;
ALTER TABLE calendar_converted
  ADD CONSTRAINT calendar_converted_block_id_fkey
  FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE;

-- Only "sync" conversions create a tracking row (a "copy" leaves no trace and
-- keeps the feed event visible). Record which, for clarity + future use.
ALTER TABLE calendar_converted ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'sync';
