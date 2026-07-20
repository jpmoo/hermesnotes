# Hermes Notes — v2 Architecture

Companion to [`hermes-notes-v2-design-doc.md`](./hermes-notes-v2-design-doc.md). The
design doc owns the **data model and product decisions**; this doc owns the
**stack, deployment, and the deltas** we introduced when resolving open
questions. Where the two disagree, the reason is called out below.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Runtime | Node 22 (headless Ubuntu). Nothing runs on dev machines. |
| Language | TypeScript end-to-end |
| Monorepo | pnpm workspaces (`corepack enable pnpm` on the host) |
| DB | PostgreSQL + pgvector |
| ORM | Drizzle (typed queries); SQL migrations are hand-authored |
| API | Fastify |
| Auth | argon2 password hashing, cookie sessions + hashed API tokens |
| Frontend | React + Vite + TypeScript |
| Text editing | TipTap/ProseMirror — **scoped to prose inside a single text block only** |
| Collections | dnd-kit for sortable kinds; a spatial layer for canvas. Blocks are DB rows, not ProseMirror nodes. |
| Embeddings/inference | Per-user Ollama (URL + model chosen in-app) |

### Repo layout

```
packages/
  shared/   # block/property_schema/collection types + zod, shared by server & web
  db/       # drizzle schema, hand-authored SQL migrations, migrate runner
apps/
  server/   # Fastify API, auth, ollama client, embedding worker   (Phase 1)
  web/      # React + Vite client                                  (Phase 1)
```

---

## 2. Deltas from the design doc

Everything else in the design doc stands. These three points changed when the
open questions were resolved:

### 2.1 Multi-user, isolated data
The doc frames the system as single-user. We chose **multiple accounts with
fully isolated data**. Consequences:
- New tables: `users`, `api_tokens`, `user_settings`.
- `owner_id` on `blocks`, `block_types`, `tags` — every query is owner-scoped.
- The §10 block-type "seed defaults" become **per-user rows seeded at signup**,
  not global constants.
- The §11 optimistic-concurrency model is **unchanged** — it describes one user
  across multiple clients, which is still exactly our per-account situation.

### 2.2 Runtime-configurable embeddings
The doc pins `embedding vector(1536)`. But the embed model is chosen at runtime
in each user's settings pane (enter Ollama URL → connect → pick from the host's
available models), so the dimension is **not a fixed literal** — 1536 is an
OpenAI dimension and doesn't match common Ollama models (nomic 768, mxbai 1024,
bge-m3 1024, all-minilm 384).

**Resolution:** `user_settings` stores `ollama_url`, `embed_model`, `embed_dim`.
Changing the embed model is a deliberate act that marks the user's blocks stale
(`embed_source_hash = NULL`) and lets the existing re-embed cascade (§4) refill
them under the new model.

### 2.3 Embeddings in their own table, zero-padded to a fixed index width
The doc inlines the vector on `blocks`. We split it into **`block_embeddings`**:
- Keeps the hot `blocks` table (inbox/membership/collection reads) lean.
- Isolates the churn of the embedding worker from block edits.

Because different users may run different-dimension models, all vectors are
**zero-padded to a fixed width `EMBEDDING_INDEX_DIM = 2000`** before storage.
Zero-padding preserves cosine similarity *exactly* (the dot product and both
norms are unchanged), so a single HNSW `vector_cosine_ops` index serves every
model. 2000 is pgvector's HNSW dimension ceiling and covers every common Ollama
embed model. `block_embeddings.dim` records the native (pre-pad) dimension.

Search is always `WHERE owner_id = $me ORDER BY embedding <=> $paddedQuery` — the
owner filter guarantees we never compare vectors across users (or across models).

---

## 3. Embedding pipeline (concrete)

Unchanged in spirit from design-doc §4; here is the wiring:

1. On block create/edit, compute `embed_source` — `content` for text blocks,
   else `deriveEmbedSource(property_schema, properties)` (shared helper).
2. Hash-gate: if `hash(embed_source) === embed_source_hash`, do nothing.
3. Else set `embed_source_hash = NULL` (stale marker) and `updated_at = now()`.
4. A background worker polls `blocks WHERE embed_source_hash IS NULL`, calls the
   owner's Ollama `/api/embeddings` with their `embed_model`, pads the vector,
   upserts `block_embeddings`, and writes back `embed_source_hash` + `embedded_at`.
5. block_type `property_schema` change → bump `schema_version`, mark all that
   type's blocks stale → same worker refills them.

A user with no Ollama configured simply accumulates stale rows; nothing breaks,
and they backfill once settings are connected.

---

## 4. Auth model

- **Password login** → httpOnly cookie session (HMAC-signed, stateless). argon2id.
- **API tokens / access keys** → the same `api_tokens` store (sha256-hashed,
  shown once, create/revoke, `last_used_at`). Two entry points:
  - `Authorization: Bearer <token>` for programmatic/agent access.
  - **Access keys** (`POST /auth/exchange`): a "skip login" link. The key rides
    in the URL **fragment** (`#k=…`) — never sent to the server, so it stays out
    of access logs and the `Referer` header. The web client reads it, exchanges
    it for the session cookie, and immediately `replaceState`-strips it from the
    URL. It's a bearer credential, so revocation + TLS are the safety net.
- Every request resolves to an `owner_id`; there is no cross-user read path.

## 4a. First-run setup (web-driven provisioning)

The server can boot **unconfigured** — no `DATABASE_URL` needed. An `onRequest`
guard returns `503 {error:"setup_required"}` for everything except `/setup/*`
and `/health` until a DB connection is known.

- `GET /setup/status` → `{configured, hasUsers}`; the web app routes to the
  wizard when not configured.
- `POST /setup/database` takes a **privileged bootstrap connection** (a role with
  `CREATEROLE`/`CREATEDB`) plus the new app DB name/user/password. The server
  creates the role + database, installs `vector`/`pgcrypto` **as admin** (pgvector
  isn't a trusted extension, so the app role can't self-install it), runs
  migrations, persists the app connection string to `data/hermes.config.json`
  (mode 0600), and re-points the live pool. The admin password is used once and
  never stored.
- `AUTH_SECRET` is auto-generated and persisted to the same file on first run if
  not supplied via env — so first-run needs no hand-edited `.env`.
- The DB handle (`db.ts`) is a Proxy over a swappable pool, so every module can
  `import { db }` and keep working across the setup-time (re)connect.

Env always wins: set `DATABASE_URL`/`AUTH_SECRET` and the wizard is skipped.

---

## 5. Phase plan

- **Phase 0 — Foundation** ✅ monorepo, schema + migration, shared types.
- **Phase 1 — Core loop** auth, per-user settings + Ollama connect/model-list,
  block CRUD, inbox query, text-block editor, embedding worker (hash-gate).
- **Phase 2** block-type engine (property_schema → form → embed_source) +
  task/event types + schema-change cascade.
- **Phase 3+** collection kinds (document → list → table → kanban/matrix →
  masonry → canvas), smart collections, semantic search UI.

---

## 6. Deferred (tracked, not built)

- MCP interface (port v1 tools onto the block model once core is stable).
- Inference features (chat/insights) — `user_settings.inference_model` reserved.
- Desktop client & its offline expectations (design-doc §11 open item #4) —
  transport stays poll / `LISTEN`/`NOTIFY` until that's decided.
