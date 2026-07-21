-- Person and Organization join the built-in core types.
UPDATE block_types SET builtin = true WHERE name IN ('person', 'organization');

-- Lock the core fields of each built-in type (editable, but not removable).
-- event: title, description, start, end
UPDATE block_types
SET property_schema = jsonb_set(
  property_schema, '{fields}',
  (
    SELECT COALESCE(jsonb_agg(
      CASE WHEN elem->>'key' IN ('title', 'description', 'start', 'end')
        THEN elem || '{"locked":true}'::jsonb ELSE elem END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(property_schema->'fields') elem
  )
)
WHERE name = 'event' AND property_schema IS NOT NULL;

-- person: title, role, description, organization
UPDATE block_types
SET property_schema = jsonb_set(
  property_schema, '{fields}',
  (
    SELECT COALESCE(jsonb_agg(
      CASE WHEN elem->>'key' IN ('title', 'role', 'description', 'organization')
        THEN elem || '{"locked":true}'::jsonb ELSE elem END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(property_schema->'fields') elem
  )
)
WHERE name = 'person' AND property_schema IS NOT NULL;

-- organization: title, description, parent
UPDATE block_types
SET property_schema = jsonb_set(
  property_schema, '{fields}',
  (
    SELECT COALESCE(jsonb_agg(
      CASE WHEN elem->>'key' IN ('title', 'description', 'parent')
        THEN elem || '{"locked":true}'::jsonb ELSE elem END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(property_schema->'fields') elem
  )
)
WHERE name = 'organization' AND property_schema IS NOT NULL;
