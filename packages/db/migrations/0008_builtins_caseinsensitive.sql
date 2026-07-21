-- Re-assert built-in types + locked fields case-insensitively, so hand-created
-- or renamed types (e.g. "Organization", "Task") are still recognized. Prior
-- migrations matched exact lowercase names and missed them. Idempotent.

UPDATE block_types
SET builtin = true
WHERE lower(name) IN ('text', 'task', 'event', 'person', 'organization');

-- The text type gains a locked "description" (Body) field where it has no schema.
UPDATE block_types
SET property_schema = '{"fields":[{"key":"description","label":"Body","type":"text","order":0,"includeEmbed":true,"locked":true}]}'::jsonb
WHERE is_text = true AND property_schema IS NULL;

-- task: title, status, due, due_date
UPDATE block_types
SET property_schema = jsonb_set(property_schema, '{fields}', (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN elem->>'key' IN ('title', 'status', 'due', 'due_date')
      THEN elem || '{"locked":true}'::jsonb ELSE elem END), '[]'::jsonb)
  FROM jsonb_array_elements(property_schema->'fields') elem))
WHERE lower(name) = 'task' AND property_schema IS NOT NULL;

-- event: title, description, start, end
UPDATE block_types
SET property_schema = jsonb_set(property_schema, '{fields}', (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN elem->>'key' IN ('title', 'description', 'start', 'end')
      THEN elem || '{"locked":true}'::jsonb ELSE elem END), '[]'::jsonb)
  FROM jsonb_array_elements(property_schema->'fields') elem))
WHERE lower(name) = 'event' AND property_schema IS NOT NULL;

-- person: title, role, description, organization
UPDATE block_types
SET property_schema = jsonb_set(property_schema, '{fields}', (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN elem->>'key' IN ('title', 'role', 'description', 'organization')
      THEN elem || '{"locked":true}'::jsonb ELSE elem END), '[]'::jsonb)
  FROM jsonb_array_elements(property_schema->'fields') elem))
WHERE lower(name) = 'person' AND property_schema IS NOT NULL;

-- organization: title, description, parent
UPDATE block_types
SET property_schema = jsonb_set(property_schema, '{fields}', (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN elem->>'key' IN ('title', 'description', 'parent')
      THEN elem || '{"locked":true}'::jsonb ELSE elem END), '[]'::jsonb)
  FROM jsonb_array_elements(property_schema->'fields') elem))
WHERE lower(name) = 'organization' AND property_schema IS NOT NULL;
