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

## Install & run

You don't need to be a developer. If you can install a couple of tools and run a few commands, you can run Hermes.

**You'll need**

- **Node.js 22+** and **pnpm 9+** — install pnpm with `npm install -g pnpm`.
- **PostgreSQL 14+** running somewhere the app can reach. On first run, Hermes' setup wizard can create its own database and install the bits it needs (the `vector` and `pgcrypto` extensions) for you — for that, give it a Postgres **admin/superuser** login (e.g. the default `postgres` user). Or point it at a database you've already made.
- *(Optional)* **[Ollama](https://ollama.com)** — only if you want semantic search and the AI assistant. Then pull a model, e.g. `ollama pull nomic-embed-text`.

**Run it**

```bash
git clone https://github.com/jpmoo/hermesnotes.git
cd hermesnotes
pnpm install
pnpm build
pnpm start
```

Now open **http://localhost:3000** in your browser. A **setup wizard** walks you through the rest: point it at your Postgres admin login, and it creates the database, installs the extensions, sets everything up, and makes your account. Done — it's running on a port.

That's the whole thing. It's a single program: one command (`pnpm start`) runs both the app and its web page on one port. To reach it from other devices or give it a real web address with HTTPS, put it behind a reverse proxy (Caddy makes this a two-line config):

```caddy
notes.example.com {
    reverse_proxy localhost:3000
}
```

**To keep it running** across reboots/crashes, use a process manager — systemd, [pm2](https://pm2.keymetrics.io/), or Docker.

---

## Configuration

Everything's optional — with nothing set, the setup wizard handles the database and generates a secret for you. If you'd rather configure by hand, copy [`.env.example`](.env.example) to `.env` and edit it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | The port the app runs on. |
| `HOST` | `0.0.0.0` | Bind address. |
| `APP_ORIGIN` | `http://localhost:3000` | Your app's public address (scheme + host, no path), for CORS + cookies. |
| `DATABASE_URL` | *(wizard)* | Postgres connection. Needs the `vector` extension. Left to the wizard if unset. |
| `AUTH_SECRET` | *(generated)* | Signing key for logins. Auto-generated if unset (`openssl rand -base64 48` to make your own). |
| `EMBEDDING_INDEX_DIM` | `2000` | Vector index width; leave as-is unless you know you need more. |
| `APP_BASE_PATH` / `PUBLIC_BASE` | *(root)* | Only needed to host under a subpath — see below. |

**Hosting under a subpath.** By default the app lives at the root of its address (`http://host:PORT/`). To host it at something like `example.com/notes` behind a reverse proxy, set both `APP_BASE_PATH=/notes/` and `PUBLIC_BASE=https://example.com/notes` in `.env` before `pnpm build`. Otherwise, ignore these.

---

## AI, search & the MCP server

- **Ollama is per-user and configured in-app** (Settings → Admin → Ollama URL + embed model). Choose an embedding model for semantic search and an inference model for the assistant. Set the similarity threshold in Settings; the Admin tab shows embedding coverage and a "re-embed all" button.
- **MCP server.** A Model Context Protocol endpoint is mounted at `<your-app>/mcp` (streamable HTTP, `Authorization: Bearer <access key>` from Settings → Access Keys). Connect Claude or any MCP client to read/search blocks and manage tasks & projects.
- **Export.** Settings → Export builds an Obsidian-compatible `.zip`: one Markdown file per block, a folder per type, a shared deduped `attachments/` folder, YAML frontmatter from your field labels, and connections as `[[wikilinks]]`.

---

## Security & deploying safely

Hermes is built for **personal use** — on your own laptop, or a home server on your own network, for you (and maybe a few people you trust). It is **not** hardened to be a public, multi-tenant service on the open internet. Running on localhost or a trusted LAN, the defaults are fine and there's nothing extra to do.

If you *do* put it on the internet (a public domain, a port forward), spend two minutes on these:

- **Finish the setup wizard before you expose it.** Until your first account exists, setup is open and *the first account to register becomes the admin* — so complete setup and create your account while the box is still private.
- **Lock down registration.** Sign-ups are open by default. Once your account exists, turn off open registration in **Settings → Admin** unless you actually want others to self-register.
- **Serve it over HTTPS behind a reverse proxy** (see the Caddy snippet under [Install & run](#install--run)). Hermes trusts the proxy's `X-Forwarded-For`, so login rate-limiting and logs see the real client — not just the proxy.
- **Set `NODE_ENV=production`.** This marks the session cookie `Secure` (HTTPS-only), which matters once you're off plain localhost.
- **Add HSTS at the proxy.** Caddy's automatic HTTPS handles this; for nginx, add a `Strict-Transport-Security` header.

A few things are handled for you: your data is strictly per-user (no account can see another's blocks), passwords are hashed with argon2id, and **permanent deletion requires a real browser login** — an AI agent connected over MCP can archive blocks but can never hard-delete your notes.

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

---

## Developing

*Only if you want to change the code* — to just run Hermes, use [Install & run](#install--run) above.

Run the two dev servers in separate terminals (hot reload). The web dev server proxies API calls to the running server:

```bash
PORT=8089 pnpm dev:server     # API, on :8089
pnpm dev:web                  # web, on http://localhost:5173
```

Other scripts: `pnpm build`, `pnpm typecheck`, `pnpm db:generate`, `pnpm db:migrate`.

## Contributing

Issues and pull requests are welcome. Please run `pnpm typecheck` before opening a PR. The [design doc](docs/hermes-notes-v2-design-doc.md) and [architecture notes](docs/hermes-notes-v2-architecture.md) explain the data model and decisions.

## Support

If Hermes is useful to you, a coffee is always appreciated ☕.

<p align="center">
  <a href="https://www.buymeacoffee.com/jpmoo" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="41" width="174"></a>
</p>

## License

Released under the [MIT License](LICENSE).
