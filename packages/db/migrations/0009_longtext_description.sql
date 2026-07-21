-- The "description" (note body / About) fields become the richer `longtext`
-- field type (a paragraph markdown editor). Only convert plain-text ones.
UPDATE block_types
SET property_schema = jsonb_set(property_schema, '{fields}', (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN elem->>'key' = 'description' AND elem->>'type' = 'text'
      THEN elem || '{"type":"longtext"}'::jsonb ELSE elem END), '[]'::jsonb)
  FROM jsonb_array_elements(property_schema->'fields') elem))
WHERE property_schema IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(property_schema->'fields') e
    WHERE e->>'key' = 'description' AND e->>'type' = 'text'
  );
