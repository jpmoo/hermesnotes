-- Daily scratchpads and weekly reflections were created just by opening a day or
-- an open review, so browsing left behind notes that were never written in. The
-- server now clears these as it goes; this removes the ones already accumulated.
--
-- Same strict guards as the runtime purge (see apps/server/src/blocks/auto-notes.ts):
-- empty content is not on its own enough to call a note empty, since a day with no
-- text can still hold a banner or a customised layout. Anything archived, or with
-- an attachment, tag or collection membership, is left alone too.
DELETE FROM blocks b
 WHERE b.archived_at IS NULL
   AND COALESCE(b.content, '') = ''
   AND (jsonb_exists(b.properties, 'today_note') OR jsonb_exists(b.properties, 'review_reflection'))
   AND NOT jsonb_exists(b.properties, 'banner')
   AND NOT jsonb_exists(b.properties, 'layout')
   AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.block_id = b.id)
   AND NOT EXISTS (SELECT 1 FROM block_tags t WHERE t.block_id = b.id)
   AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.block_id = b.id);
