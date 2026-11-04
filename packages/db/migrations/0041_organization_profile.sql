-- An account's organizations say they are, and its people say which field holds theirs.
--
-- pkm-interchange gained an `organization` profile (LIMITS: "An organization could
-- be pointed at and not known for one"). A new account's types declare it from the
-- seed (blocks/seed.ts); this gives an existing account's the same.
--
-- Which type: any already declaring it is left; else the built-in one under the
-- seed's name, whatever its case, since nothing else says what it is. Slots only
-- for fields it still has: a mapping onto a field that is gone does not validate.
-- `parent` only where it is still a reference, which the slot requires.
--
-- Then each type declaring `contact` gains an `organization` slot, where it has no
-- such slot and has a reference field pointing at that organization type. A slot
-- already there, words or reference, is the user's and is left.
--
-- Re-runnable.
UPDATE block_types t
SET property_schema = jsonb_set(
  t.property_schema,
  '{profiles}',
  COALESCE(t.property_schema->'profiles', '{}'::jsonb) || jsonb_build_object(
    'organization',
    (
      SELECT COALESCE(jsonb_object_agg(s.slot, to_jsonb(s.field)), '{}'::jsonb)
      FROM (VALUES ('title', 'title', false), ('body', 'description', false), ('parent', 'parent', true)) s(slot, field, ref)
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(t.property_schema->'fields') f
        WHERE f->>'key' = s.field AND (NOT s.ref OR f->>'type' = 'reference')
      )
    )
  )
)
WHERE t.builtin
  AND lower(t.name) = 'organization'
  AND t.property_schema IS NOT NULL
  AND jsonb_typeof(t.property_schema->'fields') = 'array'
  AND NOT COALESCE(t.property_schema->'profiles' ? 'organization', false)
  AND NOT EXISTS (
    SELECT 1 FROM block_types o
    WHERE o.owner_id = t.owner_id AND o.property_schema->'profiles' ? 'organization'
  );

UPDATE block_types c
SET property_schema = jsonb_set(c.property_schema, '{profiles,contact,organization}', to_jsonb(r.key))
FROM (
  SELECT DISTINCT ON (t.id) t.id, f->>'key' AS key
  FROM block_types t
  CROSS JOIN LATERAL jsonb_array_elements(t.property_schema->'fields') f
  JOIN block_types o ON o.owner_id = t.owner_id AND o.property_schema->'profiles' ? 'organization'
  WHERE t.property_schema->'profiles' ? 'contact'
    AND jsonb_typeof(t.property_schema->'fields') = 'array'
    AND f->>'type' = 'reference'
    AND f->>'refTypeId' = o.id::text
  ORDER BY t.id, (f->>'key' = 'organization') DESC, (f->>'order')::int
) r
WHERE c.id = r.id
  AND NOT (c.property_schema->'profiles'->'contact' ? 'organization');
