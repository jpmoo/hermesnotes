-- Keep each feed's last good ICS body, so the calendar renders from it the
-- moment it's asked instead of waiting on the calendar host. The validators let
-- a refresh come back 304 and cost nothing; the error columns carry enough to
-- explain a failure to the user rather than showing them a raw exception.
ALTER TABLE calendar_feeds
  ADD COLUMN IF NOT EXISTS cache_text text,
  ADD COLUMN IF NOT EXISTS cached_at timestamptz,
  ADD COLUMN IF NOT EXISTS etag text,
  ADD COLUMN IF NOT EXISTS last_modified text,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_status integer,
  ADD COLUMN IF NOT EXISTS last_detail text;
