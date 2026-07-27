-- Remove malformed tags whose stored name still carries a leading '#' — the
-- double-hash artifacts (e.g. '##do', '##decide') from an earlier bug where a
-- typed '#' wasn't stripped. Correct tag names are stored WITHOUT a '#', so
-- this pattern targets only the duplicates; the genuine '#do'/'#decide'/etc.
-- (stored as 'do'/'decide') are untouched. block_tags rows cascade with the tag.
DELETE FROM tags WHERE name LIKE '#%';
