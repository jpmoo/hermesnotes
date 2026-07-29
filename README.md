# Hermes Notes

**A block-first personal knowledge base — where notes, tasks, and projects are all the same thing, and everything connects.**

Hermes Notes is a self-hosted PKB. Every piece of information — a note, a task, a project, a person, a bookmark — is a **block** of a type you define. Blocks link to each other, roll up into flexible **collections** (lists, tables, kanban matrices, calendars, or an infinite canvas), and are searchable by keyword *and* meaning. It ships with daily notes, a weekly-review workflow, an optional local AI assistant, an MCP server for agents, and one-click export to Obsidian-compatible Markdown.

> I'm a vibe-coder, and Claude did all of the heavy lifting here. Expect some hard edges here and there!

<p align="center">
  <a href="https://www.buymeacoffee.com/jpmoo" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="41" width="174"></a>
</p>

---

## Highlights

- **Block-first data model.** Define your own block types (Task, Project, Person, Book…) with typed fields — text, long-text (Markdown), dates & date-spans, numbers, selects, status, references to other blocks, and file attachments.
- **Everything links.** Inline `@`/`#`/`|` mentions, reference fields, and a live backlinks/connections panel. Links to deleted blocks are surfaced so you can clean them up.
- **Collections, many shapes.** Group blocks as a **list**, **table**, **kanban matrix** (rows × columns × regions), **calendar**, **document**, or **infinite canvas** — including *smart* collections driven by a query builder.
- **Tasks & projects.** Statuses, due/scheduled date-spans, recurrence, and project relations. On a canvas, drawing a link from a task to a project files it under that project.
- **Daily notes & weekly review.** A dated scratchpad per day, plus a configurable weekly-review flow with reflections.
- **Semantic + keyword search.** Full-text search everywhere, backed by vector embeddings (via your own Ollama model) for "find things like this."
- **Local AI assistant (optional).** Chat over your knowledge base using an Ollama model you choose — nothing leaves your server.
- **MCP server built in.** Point Claude or any MCP client at your notes to read, search, and manage tasks/projects.
- **Obsidian-compatible export.** Download a `.zip` of Markdown files (one per block, a folder per type, deduped attachments, YAML frontmatter, and `[[wikilinks]]`).
- **Yours to run.** Postgres for storage, per-user Ollama config, nightly database backups, and a first-run setup wizard so you don't have to hand-write config.

---

## Quick start (local)

**Prerequisites**

- **Node.js 22+** and **pnpm 9+** (`npm i -g pnpm`)
- **PostgreSQL 14+** running locally. The first-run wizard can create the database and install the required `vector` (pgvector) and `pgcrypto` extensions for you — for that it needs a **superuser** admin login (e.g. the default `postgres` role). Alternatively, point Hermes at a database you've already prepared.
- *(Optional)* **[Ollama](https://ollama.com)** if you want embeddings/semantic search and the AI assistant. Pull an embedding model, e.g. `ollama pull nomic-embed-text`.

**Run it**

```bash
git clone https://github.com/jpmoo/hermesnotes.git
cd hermesnotes
pnpm install

# Start the API server (dev). The web dev server proxies to it on :8089.
PORT=8089 APP_ORIGIN=http://localhost:5173 pnpm dev:server

# In a second terminal, start the web app:
pnpm dev:web
```

Open **http://localhost:5173/hermesnotes/**. On first run you'll get a **setup wizard**: give it your Postgres admin connection, and it provisions the database, installs the extensions, runs migrations, and creates your account. That's it.

> Don't want the wizard? Set `DATABASE_URL` and `AUTH_SECRET` yourself (see [Configuration](#configuration)), run `pnpm db:migrate`, then start the server.

---

## Production deployment

Hermes is a single Node process: build the web bundle, and the server serves both the API and the static app on one port.

```bash
git clone https://github.com/jpmoo/hermesnotes.git
cd hermesnotes
pnpm install
pnpm build                 # typechecks + builds apps/web/dist

# Configure the server (or let the first-run wizard do it):
cp .env.example .env        # then edit DATABASE_URL, AUTH_SECRET, APP_ORIGIN, PORT
pnpm db:migrate             # if you set DATABASE_URL yourself

pnpm --filter @hermes/server start   # serves API + web on $PORT
```

Then put it behind a reverse proxy (Caddy, nginx, …) for TLS and a stable hostname, and run it under a process manager (systemd, pm2, Docker…). A typical Caddy block:

```caddy
app.example.com {
    reverse_proxy localhost:3000
}
```

**Hosting path.** The app is mounted under the subpath **`/hermesnotes/`** by default. To serve it at the root (`/`) or a different path, change the `BASE` constant at the top of [`apps/web/vite.config.ts`](apps/web/vite.config.ts) and rebuild. The MCP endpoint and all asset URLs derive from it automatically.

---

## Configuration

All server settings are environment variables (see [`.env.example`](.env.example)). **All of them are optional** — with none set, the first-run wizard configures the database and generates an auth secret for you.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | *(wizard)* | Postgres connection for the app. Needs the `vector` extension. If unset, the wizard provisions it and writes `data/hermes.config.json`. |
| `AUTH_SECRET` | *(generated)* | Signing key for sessions/tokens. Generate with `openssl rand -base64 48`. Auto-generated and persisted if unset. |
| `PORT` | `3000` | HTTP port. (Use `8089` in dev to match the web proxy.) |
| `HOST` | `0.0.0.0` | Bind address. |
| `APP_ORIGIN` | `http://localhost:5173` | Public origin of the web app, for CORS + cookies. Set to your real hostname in production. |
| `EMBEDDING_INDEX_DIM` | `2000` | Zero-padded width of the vector index. Must be ≥ the largest embedding model dimension you'll use. |
| `HERMES_CONFIG_PATH` | `data/hermes.config.json` | Where the wizard writes the persisted DB URL + auth secret. |

---

## AI, search & the MCP server

- **Ollama is per-user and configured in-app** (Settings → Admin → Ollama URL + embed model). Choose an embedding model for semantic search and an inference model for the assistant. Set the similarity threshold in Settings; the Admin tab shows embedding coverage and a "re-embed all" button.
- **MCP server.** A Model Context Protocol endpoint is mounted at `<your-app>/mcp` (streamable HTTP, `Authorization: Bearer <access key>` from Settings → Access Keys). Connect Claude or any MCP client to read/search blocks and manage tasks & projects.
- **Export.** Settings → Export builds an Obsidian-compatible `.zip`: one Markdown file per block, a folder per type, a shared deduped `attachments/` folder, YAML frontmatter from your field labels, and connections as `[[wikilinks]]`.

---

## Tech stack

TypeScript · **Fastify** (API) · **PostgreSQL + pgvector** · **Drizzle** (schema/migrations) · **React + Vite + TipTap** (web). A pnpm monorepo.

```
packages/shared   Shared block/property-schema types (zod)
packages/db       Drizzle schema + SQL migrations
apps/server       Fastify API (also serves the built web app + MCP)
apps/web          React client
docs/             Design doc + architecture notes
```

Handy scripts: `pnpm dev:server`, `pnpm dev:web`, `pnpm build`, `pnpm typecheck`, `pnpm db:generate`, `pnpm db:migrate`.

---

## Contributing

Issues and pull requests are welcome. Please run `pnpm typecheck` before opening a PR. The [design doc](docs/hermes-notes-v2-design-doc.md) and [architecture notes](docs/hermes-notes-v2-architecture.md) explain the data model and decisions.

## Support

If Hermes is useful to you, a coffee is always appreciated ☕.

<p align="center">
  <a href="https://www.buymeacoffee.com/jpmoo" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="41" width="174"></a>
</p>

## License

Released under the [MIT License](LICENSE).
