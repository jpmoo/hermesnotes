-- Default semantic-similarity floor, used where a query has no per-condition slider.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS default_similarity real NOT NULL DEFAULT 0.75;
