-- Give the built-in text type an attachments field.
--
-- Attachments are keyed by block_id in their own table, so a text block could
-- always *have* them — there was simply no field on the type, and therefore
-- nowhere in the editor to add or see one. Every other kind of block that
-- accepts a file says so with a field; this makes the note say it too, which is
-- what an Obsidian import needs in order to land `![[image.png]]` somewhere a
-- person can find it again.
--
-- Not locked: this is an affordance rather than part of what a note *is*, so
-- somebody who doesn't want it can take it off the type.
--
-- Skips any text type that already has an attachments field, so re-running is
-- safe and a hand-added one is never duplicated.
UPDATE block_types t
SET property_schema = jsonb_set(
  t.property_schema,
  '{fields}',
  (t.property_schema->'fields') || jsonb_build_array(
    jsonb_build_object(
      'key', 'attachments',
      'label', 'Attachments',
      'type', 'attachments',
      'order', 1,
      'includeEmbed', false
    )
  )
)
WHERE t.is_text = true
  AND t.property_schema IS NOT NULL
  AND jsonb_typeof(t.property_schema->'fields') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(t.property_schema->'fields') f
    WHERE f->>'type' = 'attachments' OR f->>'key' = 'attachments'
  );
