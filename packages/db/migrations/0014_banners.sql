-- Standalone banner images (separate from attachments): uploaded once, then
-- referenced by a block/collection's properties.banner or a UI preference.
CREATE TABLE IF NOT EXISTS banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime text NOT NULL,
  size integer NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS banners_owner_idx ON banners (owner_id);
