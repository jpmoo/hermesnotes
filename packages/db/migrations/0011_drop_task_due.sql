-- The task Available/Due are now the `schedule` datespan; drop any leftover
-- standalone `due` / `available` fields. Only when a schedule field exists.
UPDATE block_types
SET property_schema = jsonb_set(property_schema, '{fields}', (
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
  FROM jsonb_array_elements(property_schema->'fields') elem
  WHERE elem->>'key' NOT IN ('due', 'available')))
WHERE lower(name) = 'task' AND property_schema IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(property_schema->'fields') e WHERE e->>'key' = 'schedule'
  );

-- Carry existing task values into the schedule datespan when it isn't set yet.
UPDATE blocks b
SET properties = b.properties || jsonb_build_object(
  'schedule',
  jsonb_strip_nulls(jsonb_build_object('start', b.properties->>'available', 'end', b.properties->>'due'))
)
FROM block_types t
WHERE b.block_type_id = t.id AND lower(t.name) = 'task'
  AND (b.properties ? 'available' OR b.properties ? 'due')
  AND NOT (b.properties ? 'schedule');
