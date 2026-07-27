-- Give the built-in Task type a "project" reference field pointing at each
-- user's Project type (added in 0019). Skip any task type that already has a
-- 'project' field so we never duplicate one.
UPDATE block_types t
SET property_schema = jsonb_set(
  t.property_schema,
  '{fields}',
  (t.property_schema->'fields') || jsonb_build_array(
    jsonb_build_object(
      'key', 'project',
      'label', 'Project',
      'type', 'reference',
      'order', 5,
      'includeEmbed', false,
      'locked', true,
      'refTypeId', p.id::text
    )
  )
)
FROM block_types p
WHERE t.owner_id = p.owner_id
  AND lower(t.name) = 'task'
  AND lower(p.name) = 'project'
  AND t.property_schema IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(t.property_schema->'fields') f
    WHERE f->>'key' = 'project'
       OR (f->>'type' = 'reference' AND f->>'refTypeId' = p.id::text)
  );
