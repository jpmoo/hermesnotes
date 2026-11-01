-- A text type's note title put back where a saved profile lost it.
--
-- A text note's title is the block's own (`title`), not a field on its type,
-- so the type editor's Title menu had nothing to show for it and read "no
-- fitting field": a text type saved there with its note profile declared lost
-- its title slot, and its notes went to other apps unnamed. The editor now
-- offers "Its title" and never drops what a slot holds; this restores the slot
-- for a type saved before it did.
UPDATE block_types t
SET property_schema = jsonb_set(t.property_schema, '{profiles,note,title}', '"title"'::jsonb)
WHERE t.is_text = true
  AND jsonb_typeof(t.property_schema->'profiles'->'note') = 'object'
  AND NOT (t.property_schema->'profiles'->'note' ? 'title');
