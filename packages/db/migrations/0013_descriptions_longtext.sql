-- The notes/description box (not the title) on event / organization / person /
-- project / task types becomes longtext (markdown), now that the longtext
-- editor is solid. Only the field keyed 'description' flips; titles and other
-- text fields stay plain text. Values are unchanged (both are strings), so no
-- embed recompute or schema-version bump is needed.
UPDATE block_types
SET property_schema = jsonb_set(property_schema, '{fields}', (
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN elem->>'key' = 'description' AND elem->>'type' = 'text'
        THEN jsonb_set(elem, '{type}', '"longtext"'::jsonb)
      ELSE elem
    END
  ), '[]'::jsonb)
  FROM jsonb_array_elements(property_schema->'fields') elem
))
WHERE is_text = false
  AND property_schema IS NOT NULL
  AND lower(name) IN ('event', 'organization', 'person', 'project', 'task');
