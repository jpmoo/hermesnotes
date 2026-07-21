-- Built-in typed types (task/event/person/organization) use plain text for
-- their description; only the text-note body stays longtext.
UPDATE block_types
SET property_schema = jsonb_set(property_schema, '{fields}', (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN elem->>'type' = 'longtext' THEN jsonb_set(elem, '{type}', '"text"'::jsonb) ELSE elem END
  ), '[]'::jsonb)
  FROM jsonb_array_elements(property_schema->'fields') elem
))
WHERE builtin = true AND is_text = false AND property_schema IS NOT NULL;
