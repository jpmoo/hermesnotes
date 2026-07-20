-- Hermes Notes v2 — initial schema
-- Requires the pgvector extension to be available on the server.
-- Applied by src/migrate.ts in filename order.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ── Identity & isolation ─────────────────────────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  token_hash  text NOT NULL UNIQUE,   -- sha256 of the presented token
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_owner_idx ON api_tokens(owner_id);

-- Per-user settings. Ollama URL + model choices live here, NOT in server env.
CREATE TABLE user_settings (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ollama_url      text,
  embed_model     text,
  embed_dim       integer,   -- native dimension of embed_model; drives zero-pad width check
  inference_model text,      -- not yet used; reserved
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Block types (declarative; seeded per-user) ───────────────────────
CREATE TABLE block_types (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  icon_key        text,
  icon_color      text,
  icon_source     text NOT NULL DEFAULT 'lucide',  -- 'lucide' | 'custom'
  show_icon       boolean NOT NULL DEFAULT true,
  property_schema jsonb,
  schema_version  integer NOT NULL DEFAULT 1,       -- bumped on property_schema change
  is_text         boolean NOT NULL DEFAULT false,   -- text block: embeds `content`, no property_schema
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- ── Blocks ───────────────────────────────────────────────────────────
CREATE TABLE blocks (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  block_type_id             uuid NOT NULL REFERENCES block_types(id),
  collection_kind           text,  -- null unless this block IS a collection
  content                   text,  -- text blocks only
  properties                jsonb NOT NULL DEFAULT '{}'::jsonb,
  embed_source              text,
  embed_source_hash         text,
  embedded_at               timestamptz,
  block_type_schema_version integer NOT NULL DEFAULT 1,
  version                   integer NOT NULL DEFAULT 1,  -- optimistic concurrency
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blocks_owner_idx ON blocks(owner_id);
CREATE INDEX blocks_type_idx ON blocks(block_type_id);
-- Hash-gate stale detection: rows needing (re)embedding.
CREATE INDEX blocks_needs_embed_idx ON blocks(owner_id)
  WHERE embed_source_hash IS NULL;

-- Embeddings live apart from the hot `blocks` table. Vectors are zero-padded to
-- a fixed index width so heterogeneous per-user model dimensions share one HNSW
-- index (zero-padding preserves cosine similarity exactly). See architecture doc.
CREATE TABLE block_embeddings (
  block_id    uuid PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model       text NOT NULL,
  dim         integer NOT NULL,          -- native dimension actually produced
  embedding   vector(2000) NOT NULL,     -- padded to EMBEDDING_INDEX_DIM
  embedded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX block_embeddings_owner_idx ON block_embeddings(owner_id);
CREATE INDEX block_embeddings_hnsw_idx
  ON block_embeddings USING hnsw (embedding vector_cosine_ops);

-- ── Membership graph ─────────────────────────────────────────────────
CREATE TABLE memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  block_id      uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  position      text,          -- fractional index, scoped to collection_id
  region        text,          -- 'header' | 'body' | 'footer' (document kind)
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  hidden        boolean NOT NULL DEFAULT false,  -- smart collections only
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, block_id)
);
CREATE INDEX memberships_block_idx ON memberships(block_id);
CREATE INDEX memberships_collection_idx ON memberships(collection_id);

CREATE TABLE block_relations (
  source_id     uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  target_id     uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  relation_type text NOT NULL,  -- 'links_to' | 'references' | ...
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, target_id, relation_type)
);
CREATE INDEX block_relations_target_idx ON block_relations(target_id);

-- ── Tags ─────────────────────────────────────────────────────────────
CREATE TABLE tags (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     text NOT NULL,
  UNIQUE (owner_id, name)
);

CREATE TABLE block_tags (
  block_id uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  tag_id   uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (block_id, tag_id)
);
CREATE INDEX block_tags_tag_idx ON block_tags(tag_id);
