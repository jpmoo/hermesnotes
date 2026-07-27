-- Persisted AI-assistant conversation: one ongoing thread per user, plus the
-- occasional rolling "summary" row that condenses older turns once the thread
-- approaches the model's context window.
CREATE TABLE assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq bigserial NOT NULL,
  role text NOT NULL,                       -- 'user' | 'assistant'
  kind text NOT NULL DEFAULT 'message',     -- 'message' | 'summary'
  content text NOT NULL DEFAULT '',
  steps jsonb,                              -- tool calls the assistant made, if any
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_messages_user_seq ON assistant_messages (user_id, seq);
