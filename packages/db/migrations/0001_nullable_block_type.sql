-- Collections are blocks with collection_kind set and no block_type (their
-- title/description/settings live in properties). Allow a null block_type_id.
ALTER TABLE blocks ALTER COLUMN block_type_id DROP NOT NULL;
