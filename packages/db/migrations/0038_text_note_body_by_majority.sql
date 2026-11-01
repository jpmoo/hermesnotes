-- 0037 again, deciding by where a text type's blocks keep their words rather than by any one of them.
--
-- 0037 left a text type alone if even one of its blocks held something in
-- `description` — and an account with thousands of notes in `content` and a
-- few with words in `description` (an import, a welcome note) kept its note
-- body pointed at the empty field. A type's note words are where its blocks
-- keep them: `content`, when more of them hold words there than in
-- `description`.
UPDATE block_types t
SET property_schema = jsonb_set(t.property_schema, '{profiles,note,body}', '"content"'::jsonb)
WHERE t.is_text = true
  AND t.property_schema->'profiles'->'note'->>'body' = 'description'
  AND (SELECT count(*) FROM blocks b WHERE b.block_type_id = t.id AND COALESCE(b.content, '') <> '')
    > (SELECT count(*) FROM blocks b WHERE b.block_type_id = t.id AND COALESCE(b.properties->>'description', '') <> '');
