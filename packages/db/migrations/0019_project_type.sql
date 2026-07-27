-- Add a built-in "project" type (clipboard icon, orange) with title + about
-- fields for every existing user. Skip any user who already has a project(s)
-- type so we never clobber or duplicate one they made themselves.
INSERT INTO block_types (owner_id, name, is_text, builtin, property_schema, icon_key, icon_color, icon_source, schema_version)
SELECT
  u.id,
  'project',
  false,
  true,
  '{"fields":[
     {"key":"title","type":"text","order":0,"includeEmbed":true,"locked":true},
     {"key":"description","label":"About","type":"longtext","order":1,"includeEmbed":true,"locked":true}
   ]}'::jsonb,
  'clipboard',
  '#e8833a',
  'lucide',
  1
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM block_types bt
  WHERE bt.owner_id = u.id AND lower(bt.name) IN ('project', 'projects')
);
