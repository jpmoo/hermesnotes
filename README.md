# Hermes Notes

**A block-first personal knowledge base — where notes, tasks, and projects are all the same thing, and everything connects.**

Hermes Notes is a self-hosted PKB. Every piece of information — a note, a task, a project, a person, a bookmark — is a **block** of a type you define. Blocks link to each other, roll up into flexible **collections** (lists, tables, kanban matrices, calendars, or an infinite canvas), and are searchable by keyword *and* meaning. It ships with daily notes, a weekly-review workflow, reusable templates, an optional local AI assistant, an MCP server for agents, and one-click export to Obsidian-compatible Markdown.

> I'm a vibe-coder, and Claude did all of the heavy lifting here. Expect some hard edges here and there!

<p align="center">
  <a href="https://www.buymeacoffee.com/jpmoo" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="41" width="174"></a>
</p>

---

## Couple o' screenshots
<p align="center"><img width="35%" height="35%" alt="image" src="https://github.com/user-attachments/assets/76f03741-4268-4657-8666-5652af969126" />
&nbsp;<img width="35%" height="35%" alt="image" src="https://github.com/user-attachments/assets/86e58c5b-e261-43ae-830e-33e34555548f" /></p>

## Highlights

- **Block-first data model.** Define your own block types (Task, Project, Person, Book…) with typed fields — text, long-text (Markdown), dates & date-spans, numbers, selects, status, references to other blocks, and file attachments.
- **Everything links.** Inline `@`/`#`/`|` mentions, reference fields, and a live backlinks/connections panel. Links to deleted blocks are surfaced so you can clean them up.
- **Collections, many shapes.** Group blocks as a **list**, **table**, **kanban matrix** (rows × columns × regions), **calendar**, **spread**, **rollup** (a heading per project with its tasks nested under it), or **infinite canvas** — including *smart* collections driven by a query builder.
- **Tasks & projects.** Statuses, due/scheduled date-spans, recurrence, and project relations. On a canvas, drawing a link from a task to a project files it under that project. A project's own page shows everything hanging off it — a section per type, each with its own sort, grouping and view — so opening a project answers "what is the state of this" and not just "what is this".
- **A calendar you can live in.** Month, week, three-day and day views over dated blocks and your subscribed feeds. A span across days reads as one band rather than a staircase, the all-day row opens out or says how much it's holding, each type gets its own pill to show or hide, and finished things sink to the bottom of the day instead of leaving it.
- **Live on every device.** The database itself records what changed, so an edit on your phone reaches the tab open on your desk — including the writes no HTTP request would have revealed: a day re-seeded on read, a tag renamed across a hundred notes, a placeholder turned real.
- **Daily notes & weekly review.** A dated scratchpad per day, plus a configurable weekly-review flow with reflections.
- **Send text forward.** Select anything in a daily note or weekly reflection and send it forward: it's copied into the next one, and the one after that, until you call it off. Days you never wrote in are skipped rather than breaking the thread, and earlier notes keep what they carried — stopping it tomorrow doesn't rewrite yesterday. Every copy is stamped with the day it set out from, so a line you keep meeting says how long you've been carrying it. Or send it to **particular days** instead — pick them off a calendar, and the text is set down on each and travels no further.
- **Templates.** Named prose you keep reaching for. Right-click in any long-text field to apply one, attach one to a type's field so new blocks of that type start with it, or make one the shape every daily note or weekly reflection opens with. Two marks, each alone on a line: `/` is where the caret lands when you open the field, and `%` is where text sent forward from the last note arrives.
- **Semantic + keyword search.** Full-text search everywhere, backed by vector embeddings (via your own Ollama model) for "find things like this."
- **Local AI assistant (optional).** Chat over your knowledge base using an Ollama model you choose — nothing leaves your server.
- **MCP server built in.** Point Claude or any MCP client at your notes to read, search, and manage tasks/projects.
- **Obsidian-compatible export.** Download a `.zip` of Markdown files (one per block, a folder per type, deduped attachments, YAML frontmatter, and `[[wikilinks]]`).
- **On the Mac, properly.** [Talaria](talaria/README.md) mirrors your account to the laptop and hands it to the operating system: Spotlight, a `talaria://` scheme, a Services entry that captures selected text from any app, a menu bar board you can drag cards around, an Ask-Hermes prompt on a hotkey, and a `talaria` command. Reads never touch the network, so it all works on a plane.
- **Portable on purpose.** Hermes speaks [pkm-interchange](pkm-interchange/), a small format for moving personal-knowledge objects between tools that model them differently. Your types travel with your data and explain themselves, so another tool can find which field is a due date and which values mean finished without being told. `GET /api/conformance` says what this instance honours; `GET /api/interchange` hands over everything it holds — and reports what it could not express, rather than leaving you to notice.
- **Yours to run.** Postgres for storage, per-user Ollama config, nightly database backups, and a first-run setup wizard so you don't have to hand-write config.

---

## Install & run

You don't need to be a developer. If you can install a couple of tools and run a few commands, you can run Hermes.

**You'll need**

- **Node.js 22+** and **pnpm 9+** — install pnpm with `npm install -g pnpm`.
- **PostgreSQL 14+** with the **pgvector** extension available, running somewhere the app can reach. Hermes keeps note embeddings in a `vector` column, so pgvector is required — [installing it](#installing-postgresql-and-pgvector) is one command. On first run, Hermes' setup wizard creates its own database and turns on the extensions it needs (`vector` and `pgcrypto`) — for that, give it a Postgres **admin/superuser** login (e.g. the default `postgres` user). Or point it at a database you've already made.
- *(Optional)* **[Ollama](https://ollama.com)** — only if you want semantic search and the AI assistant. Then pull a model, e.g. `ollama pull nomic-embed-text`.

### Installing PostgreSQL and pgvector

The setup wizard can *enable* pgvector, but it can't install it — the files have to be on the database server first. If they aren't, setup stops with "PostgreSQL doesn't have the pgvector extension installed".

The package is named for the PostgreSQL major version it belongs to, so check that first.

**Debian / Ubuntu**

```bash
sudo apt install -y postgresql
psql --version
```

`psql (PostgreSQL) 16.4` means the major version is **16** — install the matching package:

```bash
sudo apt install -y postgresql-16-pgvector
```

Or let the shell fill the version in for you:

```bash
sudo apt install -y "postgresql-$(pg_lsclusters -h | awk '{print $1; exit}')-pgvector"
```

If apt can't find that package, your distro's repository doesn't carry it — add the official PostgreSQL one and try again:

```bash
sudo apt install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update
```

**macOS (Homebrew)**

```bash
brew install postgresql@16 pgvector
brew services start postgresql@16
```

**Docker** — use the pgvector image in place of `postgres`; it's the stock image with the extension already in it:

```bash
docker run -d --name hermes-pg -p 5432:5432 -e POSTGRES_PASSWORD=choose-one pgvector/pgvector:pg16
```

**Check it worked.** No restart is needed — the extension is just files on disk until a database turns it on:

```bash
sudo -u postgres psql -c "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector'"
```

One row back means Hermes' setup wizard can take it from here. Nothing back means the package didn't land for the version PostgreSQL is actually running.

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

## Interoperating

Hermes is the first implementation of [**pkm-interchange**](pkm-interchange/), a
format for exchanging personal-knowledge objects between tools that model them
differently — notes, tasks, boards, recurrences, the links between them.

```bash
curl https://your-host/api/conformance
```

```json
{ "format": "pkm-interchange/0",
  "produce": 4, "consume": 4, "operate": 4,
  "bindings": ["file", "http", "mcp"],
  "profiles": ["task", "note"],
  "features": ["series", "placement", "derivations", "relations", "attachments"],
  "unsupported": [] }
```

Those numbers are not a claim anyone has to take on trust: they are checked
against a fixture suite on every run, per role, and the build fails if the
manifest says more than the suite earned.

- **`GET /api/conformance`** — what this instance honours, without credentials,
  so a client can ask before it writes.
- **`GET /api/interchange`** — the whole account as one envelope, with a
  `findings` list saying what Hermes could not express. An export that reports
  nothing is claiming to have lost nothing.
- **Four MCP tools** — `interchange_conformance`, `interchange_types`,
  `interchange_object`, `interchange_patch` — so an agent that has never heard of
  Hermes can read your types in shared vocabulary and change one field without
  destroying the rest.

The format, its fixtures and a checker live in [`pkm-interchange/`](pkm-interchange/)
and depend on nothing in Hermes. `npx pkm-check <export.json>` will tell you
whether any tool's export is valid, including this one's.

---

## Talaria — Hermes on macOS

[Talaria](talaria/README.md) is a macOS layer that lives in this repo under [`talaria/`](talaria/). It keeps a local SQLite mirror of your account and lends it to the rest of the system:

- **Spotlight.** ⌘Space finds your blocks and opens them, reindexed when the sync cursor moves rather than on a timer.
- **A menu bar board.** ⌃⌥B opens any collection in a floating window — a matrix with cards you drag between regions, a canvas at the coordinates the web app placed things at, an agenda that scrolls forward from today, a rollup, a table with its columns.
- **Capture from anywhere.** Select text in any app and, under Services, add it to Hermes Notes as a task or a note.
- **Ask Hermes.** ⌃⌥Space puts the assistant a keystroke away, with anything destructive coming back for approval first.
- **Hermes in a window.** A `WKWebView` window of its own, so a card, a Spotlight hit or a `talaria://` link lands in Hermes rather than a browser tab.
- **A command line.** `talaria find`, `add`, `done`, `note`, `queue`, `doctor`.

**Reads are answered from the mirror, never the network** — everything but Ask Hermes works with the machine entirely offline, and an answer that isn't current says how old it is. Writes go out immediately when the server is reachable and queue when it isn't; a task created offline gets its real id straight away, so it is findable and linkable before it has ever reached a server.

It rides on two read-only routes Hermes serves for it — `/sync/blocks` walks the account, `/sync/changes` reports what has moved since a cursor — so any other mirror could be built the same way. Setup, the config file and the LaunchAgent are in [talaria/README.md](talaria/README.md); what it asked of Hermes proper is in [HERMES-CORE-CHANGES.md](talaria/HERMES-CORE-CHANGES.md).

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
talaria/          macOS integration: mirror daemon, CLI, Talaria.app
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
