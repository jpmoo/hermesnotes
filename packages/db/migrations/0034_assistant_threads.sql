-- Conversations that live on a canvas.
--
-- The assistant had one ongoing thread per user, keyed by nothing but the user.
-- A discussion started from a node on a canvas is its own conversation: it is
-- drawn as a bubble beside the node it grew from, reopened from there, and read
-- as context by the bubbles beside it. So a thread gets a row, and a message
-- says which thread it belongs to.
--
-- **The thread names its place, not its contents.** `collection_id` is the
-- canvas, `anchor_id` the node the discussion was started from (a block id, or
-- an `n:` note id — the same vocabulary as `canvas_edges.from/to`), and
-- `note_id` the bubble itself, which is an ordinary canvas note carrying this
-- thread's id. What the discussion is *about* is gathered fresh on every turn
-- from what is connected to it, so moving a learning onto the problem changes
-- the next answer without anybody re-telling the chat.
--
-- `thread_id` null is the assistant panel's own, untitled thread: every message
-- that exists today, unchanged.

CREATE TABLE IF NOT EXISTS assistant_threads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id uuid REFERENCES blocks(id) ON DELETE CASCADE,
  anchor_id     text,
  note_id       text,
  title         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_threads_user_collection
  ON assistant_threads (user_id, collection_id);

ALTER TABLE assistant_messages
  ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES assistant_threads(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS assistant_messages_user_thread_seq
  ON assistant_messages (user_id, thread_id, seq);
