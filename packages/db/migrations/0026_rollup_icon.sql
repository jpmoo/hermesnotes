-- Rollups shipped with a list-tree glyph and were given a scroll a build later.
-- Any rollup carrying the old key was made by that one build, so move it over
-- rather than leaving those collections looking like something else everywhere
-- the stored icon is used (the info panel, the rail, mentions).
UPDATE blocks
SET properties = jsonb_set(properties, '{icon_key}', '"scroll"')
WHERE collection_kind = 'rollup'
  AND properties->>'icon_key' = 'list-tree';
