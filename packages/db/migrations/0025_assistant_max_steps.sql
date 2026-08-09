-- How many turns the assistant may take on one message before it stops and asks
-- whether to keep going. Null means the built-in default; the right number
-- depends on the model, since one that calls a single tool per turn spends them
-- far faster than one that batches.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS assistant_max_steps integer;
