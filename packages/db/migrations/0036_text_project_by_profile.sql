-- 0035 again, finding the Project type by what it says it is rather than by its name.
--
-- 0035 looked for the account's Project type by the name the seed gives it,
-- `project`; an account whose types are called Text and Project — types are the
-- user's own rows, renamed as they like — matched nothing, and its text type was
-- left without the field. The type a note's project points at is the one that
-- declares the `project` profile (a built-in one first, then the oldest), as
-- pkm-interchange has a consumer find projects — else, for an account that never
-- declared one, the built-in type under the seed's own name, as 0035 did; and any
-- text type takes it, not only a built-in one.
--
-- Otherwise as 0035: a Project relation, unlocked, and the note profile declared
-- with `project`, keeping whatever it already declares. Re-runnable, and a text
-- type that already has a field keyed `project` — from 0035, or by hand — is left.
UPDATE block_types t
SET property_schema = jsonb_set(
  jsonb_set(
    t.property_schema,
    '{fields}',
    (t.property_schema->'fields') || jsonb_build_array(
      jsonb_build_object(
        'key', 'project',
        'label', 'Project',
        'type', 'reference',
        'order', (SELECT COALESCE(MAX((f->>'order')::int), -1) + 1 FROM jsonb_array_elements(t.property_schema->'fields') f),
        'includeEmbed', false,
        'refTypeId', p.id
      )
    )
  ),
  '{profiles}',
  COALESCE(t.property_schema->'profiles', '{}'::jsonb) || jsonb_build_object(
    'note',
    jsonb_build_object('title', 'title', 'body', 'content')
      || COALESCE(t.property_schema->'profiles'->'note', '{}'::jsonb)
      || CASE WHEN t.property_schema->'profiles'->'note' ? 'project' THEN '{}'::jsonb ELSE jsonb_build_object('project', 'project') END
  )
)
FROM (
  SELECT DISTINCT ON (owner_id) owner_id, id
  FROM block_types
  WHERE property_schema->'profiles' ? 'project' OR (builtin AND name = 'project')
  ORDER BY owner_id, (property_schema->'profiles' ? 'project') DESC, builtin DESC, created_at ASC
) p
WHERE t.is_text = true
  AND p.owner_id = t.owner_id
  AND t.property_schema IS NOT NULL
  AND jsonb_typeof(t.property_schema->'fields') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(t.property_schema->'fields') f
    WHERE f->>'key' = 'project'
  );
