# Hermes Notes v2

A block-first personal knowledge management system. Ground-up rebuild of Hermes.

- **Design reference:** [`docs/hermes-notes-v2-design-doc.md`](docs/hermes-notes-v2-design-doc.md) — data model & product decisions.
- **Architecture:** [`docs/hermes-notes-v2-architecture.md`](docs/hermes-notes-v2-architecture.md) — stack, deployment, deltas.

## Stack

TypeScript · Fastify · PostgreSQL + pgvector · Drizzle · React + Vite. Per-user
Ollama (URL + model chosen in-app) for embeddings.

## Layout

```
packages/shared   shared block/property-schema types (zod)
packages/db       drizzle schema + SQL migrations
apps/server       Fastify API (Phase 1)
apps/web          React client (Phase 1)
```

## Server setup (headless Ubuntu)

Requires a running PostgreSQL (with `pgvector` available) and a reachable Ollama
host (configured per-user in the app, not here). You do **not** pre-create the
database — the first-run web wizard does that.

```bash
corepack enable pnpm
pnpm install
cp .env.example .env      # optional: set APP_ORIGIN; DATABASE_URL/AUTH_SECRET are optional
pnpm dev:server           # boots unconfigured if no DATABASE_URL
pnpm dev:web              # then open the app and complete first-run setup
```

**First run:** open the web app → the setup wizard asks for a privileged
Postgres login (able to create roles/databases) plus the new app DB
name/user/password to create → it provisions + migrates + connects, then flows
straight to creating your account. After that: normal login/register.

> Embed-model / Ollama URL are **not** environment config — each user sets them
> in their in-app settings pane. To skip the wizard, set `DATABASE_URL` +
> `AUTH_SECRET` in `.env` and run `pnpm db:migrate` yourself.

## Run (Phase 1)

Server and web run through `tsx`/Vite (workspace packages export TS source; no
separate compile step). Two processes:

```bash
pnpm dev:server     # Fastify API on :3000 + embedding worker
pnpm dev:web        # Vite dev server on :5173, proxies /api → :3000
```

Then open http://localhost:5173 — register, open **Settings** to connect your
Ollama host and pick an embed model, then add notes in the **Inbox**; they embed
in the background.

Production (single-user or multi): `pnpm --filter @hermes/server start` behind a
reverse proxy, and serve `apps/web`'s `vite build` output as static files.

## Status

- **Phase 0** ✅ monorepo, schema, migration runner, shared types.
- **Phase 1** ✅ auth (self-serve signup + API tokens), per-user Ollama settings
  + model list, block CRUD, inbox query, TipTap text-block editor, embedding
  worker (hash-gated). *Not yet exercised on real infra — see below.*
- **Phase 2** next: block-type engine (property_schema → form → embed_source) +
  task/event types + schema-change cascade.

> **Verification pending:** nothing was run locally (deploys to the Ubuntu host).
> On the server, run `pnpm install` then `pnpm typecheck` and `pnpm db:migrate`
> before first boot.
