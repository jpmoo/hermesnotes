-- Built-in core types (text/task/event) with locked, non-removable fields.
ALTER TABLE block_types ADD COLUMN IF NOT EXISTS builtin boolean NOT NULL DEFAULT false;

UPDATE block_types SET builtin = true WHERE name IN ('text', 'task', 'event');

-- The text type gains a locked "description" (Body) field where it had no schema.
UPDATE block_types
SET property_schema = '{"fields":[{"key":"description","label":"Body","type":"text","order":0,"includeEmbed":true,"locked":true}]}'::jsonb
WHERE is_text = true AND property_schema IS NULL;

-- Lock the title field on every built-in typed schema.
UPDATE block_types
SET property_schema = jsonb_set(
  property_schema, '{fields}',
  (
    SELECT COALESCE(jsonb_agg(
      CASE WHEN elem->>'key' = 'title' THEN elem || '{"locked":true}'::jsonb ELSE elem END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(property_schema->'fields') elem
  )
)
WHERE builtin = true AND is_text = false AND property_schema IS NOT NULL;

-- Lock status + due fields on the task type.
UPDATE block_types
SET property_schema = jsonb_set(
  property_schema, '{fields}',
  (
    SELECT COALESCE(jsonb_agg(
      CASE WHEN elem->>'key' IN ('status', 'due', 'due_date')
        THEN elem || '{"locked":true}'::jsonb ELSE elem END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(property_schema->'fields') elem
  )
)
WHERE name = 'task' AND property_schema IS NOT NULL;
