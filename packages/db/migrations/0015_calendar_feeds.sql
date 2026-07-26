-- External calendar subscriptions (ICS URLs from Google / Outlook / iCloud /
-- etc.). Events are fetched + parsed live (cached in memory), shown read-only
-- on calendar collection views, and never stored as blocks unless the user
-- explicitly converts one into a Hermes happening.

CREATE TABLE IF NOT EXISTS calendar_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  color text NOT NULL DEFAULT '#6b7cff',
  enabled boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_error text,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_feeds_owner_idx ON calendar_feeds(owner_id);

-- Feed events the user promoted to a Hermes block. Keyed by (feed, event UID)
-- so the source event is filtered out of the feed display from then on.
CREATE TABLE IF NOT EXISTS calendar_converted (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id uuid REFERENCES calendar_feeds(id) ON DELETE CASCADE,
  uid text NOT NULL,
  block_id uuid REFERENCES blocks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS calendar_converted_key_idx
  ON calendar_converted(owner_id, feed_id, uid);
