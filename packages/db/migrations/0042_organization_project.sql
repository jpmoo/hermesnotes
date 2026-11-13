-- Give organization types a Projects field, declared in their profiles.
--
-- pkm-interchange's organization gained a `project` slot (LIMITS: "An
-- organization could not say which project it was in"). A new account's type has
-- the field from the seed (blocks/seed.ts); this gives an existing account's the
-- same.
--
-- Which types: any declaring the `organization` profile (0041 declared it on the
-- built-in one), since types are the user's own rows, renamed as they like. The
-- target is found as 0040 finds it: the type declaring `project`, a built-in one
-- first, then the oldest; else the built-in under the seed's name.
--
-- Not locked, as a person's is not. A relation, so an organization may be in
-- several projects. Labeled Projects, as a person's is in a new account.
--
-- Re-runnable, and a type that already has a field keyed `project` is left.
WITH target AS (
  SELECT DISTINCT ON (owner_id) owner_id, id
  FROM block_types
  WHERE property_schema->'profiles' ? 'project' OR (builtin AND name = 'project')
  ORDER BY owner_id, (property_schema->'profiles' ? 'project') DESC, builtin DESC, created_at ASC
),
wanted AS (
  SELECT t.id, p.id AS project_type, t.property_schema AS schema
  FROM block_types t
  JOIN target p ON p.owner_id = t.owner_id
  WHERE t.property_schema IS NOT NULL
    AND jsonb_typeof(t.property_schema->'fields') = 'array'
    AND t.property_schema->'profiles' ? 'organization'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.property_schema->'fields') f
      WHERE f->>'key' = 'project'
    )
)
UPDATE block_types t
SET property_schema = jsonb_set(
  jsonb_set(
    w.schema,
    '{fields}',
    (w.schema->'fields') || jsonb_build_array(
      jsonb_build_object(
        'key', 'project',
        'label', 'Projects',
        'type', 'reference',
        'order', (SELECT COALESCE(MAX((f->>'order')::int), -1) + 1 FROM jsonb_array_elements(w.schema->'fields') f),
        'includeEmbed', false,
        'refTypeId', w.project_type
      )
    )
  ),
  '{profiles,organization}',
  (w.schema->'profiles'->'organization') || '{"project":"project"}'::jsonb
)
FROM wanted w
WHERE t.id = w.id;
