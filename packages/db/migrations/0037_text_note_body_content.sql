-- A text type's note words back where they are: the block's own text, `content`.
--
-- The type editor offered a note's Body slot only fields, not `content`, so a
-- text type opened and saved after 0035/0036 declared its note profile had its
-- body set to its first fitting field, `description` — which a text block does
-- not keep its words in. Read through that profile, every note's words were
-- empty, and a sync would have carried the emptiness. The editor now offers
-- "Its own words"; this puts back what the profile said before it was saved.
--
-- Only a text type whose note body is `description` while its blocks keep
-- their words in `content` — none holding anything in `description` — so a
-- type somebody really did point at a field of words is left as it is.
UPDATE block_types t
SET property_schema = jsonb_set(t.property_schema, '{profiles,note,body}', '"content"'::jsonb)
WHERE t.is_text = true
  AND t.property_schema->'profiles'->'note'->>'body' = 'description'
  AND NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE b.block_type_id = t.id
      AND COALESCE(b.properties->>'description', '') <> ''
  );
