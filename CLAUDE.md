# Working in this repo

Orientation for a coding agent. Read this first; it is short on purpose and
points at the documents that are long.

## What this is

Four things in one pnpm monorepo, in the order they depend on each other:

| | | |
|---|---|---|
| `pkm-interchange/` | the **format** | depends on nothing in here, and must keep not depending on it |
| `packages/interchange/` | Hermes **as** a producer and consumer | pure — rows in, envelope out, findings alongside |
| `apps/server`, `apps/web`, `packages/{db,shared}` | **Hermes Notes** | Fastify + Postgres/pgvector + React |
| `talaria/` | **Talaria** — macOS system integration | SQLite mirror, UDS daemon, CLI, `Talaria.app` |

## The documents, and what each one owns

- `pkm-interchange/AGENTS.md` — the specification. **The fixtures are
  authoritative; where prose and a fixture disagree the fixture is right.**
- `pkm-interchange/fixtures/README.md` — the case grammar and the ten adapter
  operations. Anything measuring an implementation goes through this.
- `pkm-interchange/README.md` — the human-facing introduction to the format.
- `LIMITS.md` (in `pkm-interchange/`) — **seven things a real client needed and
  the format could not say.** This is the v0.1 backlog and nothing links to it
  yet. Read it before proposing any format change.
- `docs/hermes-notes-v2-design-doc.md` — the block data model. Section 3's rule
  is the one that matters: *no per-type hardcoded logic.*
- `docs/hermes-notes-v2-architecture.md` — stack, auth, embeddings, setup wizard.
- `talaria/DESIGN.md` — Talaria's Phase 0 decisions and the six findings behind
  them. Parts of §3.2 are stale; see DEFECTS.md.
- `talaria/HERMES-CORE-CHANGES.md` — everything Talaria asked of Hermes proper,
  with what was verified.
- `talaria/AMBIENT.md` — the ambient-desktop design (BTT / Rift / Alfred / local
  inference). Not built.
- `DEFECTS.md` — open defects and doc drift found by review, with the reasoning.

## Naming collision, worth knowing before you trip on it

`pkm-interchange/AGENTS.md` is a **format specification**, not instructions for
you. It is named that way because it is meant to be pasted at an agent
implementing the format. An agent that auto-loads `AGENTS.md` files as behaviour
will read a wire-format spec as a set of orders. Treat it as reference.

## Invariants

Break one of these and something goes quietly wrong rather than loudly wrong,
which is why they are written down.

**`if (type.name === "Task")` is a bug.** In the format and in this codebase.
Types are user data — rows the user can rename. Completion is read through the
task profile's `status` and `completeValues`; recurrence is found by field
*type*, not field name.

**Unknown fields survive byte-identical.** In an export, in an import, and at
write time. The importer's job is to hold the original and overlay a model on
it, never to decompose into columns and reassemble.

**Unprefixed keys belong to the format.** Hermes' own go under `hermes:`.

**A manifest is checked, not written.** `packages/interchange/src/conformance.ts`
holds the claim; `pnpm --filter @hermes/interchange measure` fails the build if
the claim exceeds what the fixture run earned. Do not raise a number by hand.

**The interchange binding owns no business logic.**
`apps/server/src/interchange/routes.ts` translates vocabulary and delegates to
Hermes' own handlers via `app.inject`. Completing a task stamps a time, keeps the
series in step and spawns the next occurrence; the binding must never grow a
second copy of that.

**Talaria's seam is `packages/canonical`.** It is the only Talaria package
allowed to see a Hermes payload, enforced by `no-restricted-imports`.
`packages/canonical/src/interchange.ts` deliberately reimplements the profile
vocabulary rather than importing Hermes' copy — two independent implementations
is the only thing that makes the format prove anything. **Do not "deduplicate"
it.**

## Useful commands

```bash
pnpm --filter @hermes/interchange probe /tmp/export.json   # export a real library
node pkm-interchange/check/src/cli.js /tmp/export.json      # score it
pnpm --filter @hermes/interchange measure                   # fixtures vs real functions
pnpm --filter @hermes/interchange roundtrip                 # own library, out and back
pnpm --filter @hermes/interchange foreign                   # a stranger's library
node pkm-interchange/walkthrough.mjs                        # the README transcript, live
bash talaria/acceptance/run.sh                              # offline/reconnect scenario
bash talaria/app/check.sh                                   # every payload the app decodes, against a live daemon
pnpm -r typecheck
```

## One housekeeping note

`.claude/settings.local.json` is not in `.gitignore` and this repository is
public. Check whether it is tracked before the next push.
