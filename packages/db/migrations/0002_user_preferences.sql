-- UI preferences that sync across devices (Inbox pill colors, etc.).
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
