-- Give event and person types a Project field, declared in their profiles.
--
-- pkm-interchange's event and contact gained a `project` slot (LIMITS: "A meeting
-- or a person could not say which project they were in"). A new account's types
-- have the field from the seed (blocks/seed.ts); this gives an existing account's
-- the same.
--
-- Which types: any declaring the `event` or `contact` profile, since types are
-- the user's own rows, renamed as they like; else the built-in type under the
-- seed's name. The target is found as 0036 finds it: the type declaring `project`,
-- a built-in one first, then the oldest; else the built-in under the seed's name.
--
-- Not locked, as a note's is not: somebody who files nothing by project can take
-- it off the type. A relation, so a person may be in several projects.
--
-- A profile already declared keeps every slot it has and gains `project`. A
-- built-in type that never declared one gets the seed's slots, but only those
-- whose fields it still has: a mapping onto a field that is gone does not validate.
--
-- Re-runnable, and a type that already has a field keyed `project` is left.
WITH seed_slots(profile, slot, field, spec) AS (
  VALUES
    ('event', 'title', 'title', '"title"'::jsonb),
    ('event', 'start', 'when', '{"field":"when","part":"start"}'::jsonb),
    ('event', 'end', 'when', '{"field":"when","part":"end"}'::jsonb),
    ('event', 'location', 'location', '"location"'::jsonb),
    ('event', 'body', 'description', '"description"'::jsonb),
    ('contact', 'title', 'title', '"title"'::jsonb),
    ('contact', 'organization', 'organization', '"organization"'::jsonb),
    ('contact', 'role', 'role', '"role"'::jsonb),
    ('contact', 'body', 'description', '"description"'::jsonb)
),
target AS (
  SELECT DISTINCT ON (owner_id) owner_id, id
  FROM block_types
  WHERE property_schema->'profiles' ? 'project' OR (builtin AND name = 'project')
  ORDER BY owner_id, (property_schema->'profiles' ? 'project') DESC, builtin DESC, created_at ASC
),
wanted AS (
  SELECT
    t.id,
    p.id AS project_type,
    t.property_schema AS schema,
    COALESCE(t.property_schema->'profiles' ? 'event', false) OR (t.builtin AND t.name = 'event') AS is_event,
    COALESCE(t.property_schema->'profiles' ? 'contact', false) OR (t.builtin AND t.name = 'person') AS is_contact
  FROM block_types t
  JOIN target p ON p.owner_id = t.owner_id
  WHERE t.property_schema IS NOT NULL
    AND jsonb_typeof(t.property_schema->'fields') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.property_schema->'fields') f
      WHERE f->>'key' = 'project'
    )
),
slotted AS (
  SELECT
    w.*,
    (
      SELECT COALESCE(jsonb_object_agg(s.slot, s.spec), '{}'::jsonb)
      FROM seed_slots s
      WHERE s.profile = 'event'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.schema->'fields') f WHERE f->>'key' = s.field)
    ) AS event_seed,
    (
      SELECT COALESCE(jsonb_object_agg(s.slot, s.spec), '{}'::jsonb)
      FROM seed_slots s
      WHERE s.profile = 'contact'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.schema->'fields') f WHERE f->>'key' = s.field)
    ) AS contact_seed
  FROM wanted w
  WHERE w.is_event OR w.is_contact
)
UPDATE block_types t
SET property_schema = jsonb_set(
  jsonb_set(
    s.schema,
    '{fields}',
    (s.schema->'fields') || jsonb_build_array(
      jsonb_build_object(
        'key', 'project',
        'label', 'Project',
        'type', 'reference',
        'order', (SELECT COALESCE(MAX((f->>'order')::int), -1) + 1 FROM jsonb_array_elements(s.schema->'fields') f),
        'includeEmbed', false,
        'refTypeId', s.project_type
      )
    )
  ),
  '{profiles}',
  COALESCE(s.schema->'profiles', '{}'::jsonb)
    || CASE WHEN s.is_event
         THEN jsonb_build_object('event', COALESCE(s.schema->'profiles'->'event', s.event_seed) || '{"project":"project"}'::jsonb)
         ELSE '{}'::jsonb END
    || CASE WHEN s.is_contact
         THEN jsonb_build_object('contact', COALESCE(s.schema->'profiles'->'contact', s.contact_seed) || '{"project":"project"}'::jsonb)
         ELSE '{}'::jsonb END
)
FROM slotted s
WHERE t.id = s.id;
