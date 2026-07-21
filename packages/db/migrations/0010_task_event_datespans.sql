-- Task: replace the `due_date` field with an Available/Due datespan (`schedule`)
-- and add a locked `recurrence` field. Preserves other fields. Idempotent.
UPDATE block_types
SET property_schema = jsonb_set(
  property_schema, '{fields}',
  (
    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    FROM jsonb_array_elements(property_schema->'fields') elem
    WHERE elem->>'key' <> 'due_date'
  ) || '[
    {"key":"schedule","label":"Schedule","type":"datespan","order":2,"includeEmbed":false,"locked":true,"startLabel":"Available","endLabel":"Due"},
    {"key":"recurrence","label":"Recurrence","type":"recurrence","order":4,"includeEmbed":false,"locked":true}
  ]'::jsonb
)
WHERE lower(name) = 'task' AND property_schema IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(property_schema->'fields') e WHERE e->>'key' = 'schedule'
  );

-- Event: replace start + end with a single `when` datespan. Idempotent.
UPDATE block_types
SET property_schema = jsonb_set(
  property_schema, '{fields}',
  (
    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    FROM jsonb_array_elements(property_schema->'fields') elem
    WHERE elem->>'key' NOT IN ('start', 'end')
  ) || '[
    {"key":"when","label":"When","type":"datespan","order":2,"includeEmbed":false,"locked":true,"startLabel":"Start","endLabel":"End"}
  ]'::jsonb
)
WHERE lower(name) = 'event' AND property_schema IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(property_schema->'fields') e WHERE e->>'key' = 'when'
  );

-- Migrate task block values: schedule.end := due_date.
UPDATE blocks b
SET properties = b.properties || jsonb_build_object('schedule', jsonb_build_object('end', b.properties->>'due_date'))
FROM block_types t
WHERE b.block_type_id = t.id AND lower(t.name) = 'task'
  AND b.properties ? 'due_date' AND NOT (b.properties ? 'schedule');

-- Migrate event block values: when := { start, end }.
UPDATE blocks b
SET properties = b.properties || jsonb_build_object('when', jsonb_strip_nulls(jsonb_build_object('start', b.properties->>'start', 'end', b.properties->>'end')))
FROM block_types t
WHERE b.block_type_id = t.id AND lower(t.name) = 'event'
  AND (b.properties ? 'start' OR b.properties ? 'end') AND NOT (b.properties ? 'when');
