-- Admin flag on users; IANA timezone for day boundaries on settings.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timezone text;

-- Promote the earliest-created account to admin (best-effort for existing installs).
UPDATE users SET is_admin = true
WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1);
