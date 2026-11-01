-- Give the built-in text type a Project field, declared in its note profile.
--
-- pkm-interchange's note gained a `project` slot (LIMITS: "A note could not say
-- which project it was in"): a writing app keeps a project's pages with it, and
-- a note carried between apps lost its project on the way. A new account's text
-- type has the field from the seed (blocks/seed.ts); this gives an existing
-- account's the same, pointing at that account's own built-in Project type.
--
-- Not locked, as attachments are not: somebody who files nothing by project can
-- take it off the type. A relation, so a note may be in several projects, as a
-- task may.
--
-- The note profile is declared rather than left derived (property-schema.ts,
-- profilesOf), since a derived one has no project slot: it keeps whatever the
-- type already declares for `note` and adds `project` only where it has none.
--
-- Skips a text type that already has a field keyed `project`, so re-running is
-- safe and a hand-added one is never duplicated; and one whose account has no
-- built-in Project type, which would leave the relation pointing nowhere.
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
FROM block_types p
WHERE t.is_text = true
  AND t.builtin = true
  AND p.owner_id = t.owner_id
  AND p.builtin = true
  AND p.name = 'project'
  AND t.property_schema IS NOT NULL
  AND jsonb_typeof(t.property_schema->'fields') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(t.property_schema->'fields') f
    WHERE f->>'key' = 'project'
  );
