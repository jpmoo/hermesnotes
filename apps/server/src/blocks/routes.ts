import { and, asc, desc, eq, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyPatch, datedInRange, filterQuerySchema, inlineMentions, isComplete, nextSpan, normalizeFilter, oneLineLabel, periodicKindOf, recurrenceContinues, recurrenceSchema, stripBlankDates, TEMPLATE_MARKER, type PropertySchema } from "@hermes/shared";
import { attachments, blocks, blockTags, blockTypes, memberships, series, tags, userSettings } from "@hermes/db";
import { db } from "../db.js";
import { syncSeries } from "./series.js";
import { runQuery, runQueryCounted, semanticIds } from "../collections/query.js";
import { sha256 } from "../lib/hash.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { computeEmbedSource } from "./embed-source.js";
import { buildGraph } from "./graph.js";

/** Tag names from `#` mentions: `(tag:<name>)` links anywhere, and — in
 * `rawTexts` (title/plain-text fields, where raw mention syntax is stored) —
 * bare `#tag` tokens at a word start. */
function extractTags(texts: string[], rawTexts: string[] = []): Set<string> {
  const names = new Set<string>();
  for (const t of texts) {
    if (typeof t !== "string") continue;
    const re = /\(tag:([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const n = m[1]?.trim().toLowerCase();
      if (n) names.add(n);
    }
  }
  for (const t of rawTexts) {
    if (typeof t !== "string") continue;
    const re = /(^|\s)#([A-Za-z0-9][\w-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const n = m[2]?.trim().toLowerCase();
      if (n) names.add(n);
    }
  }
  return names;
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Apply a string rewriter to every string value in a JSON tree. */
function rewriteStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => rewriteStrings(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteStrings(v, fn);
    return out;
  }
  return value;
}

/** Strip one target block's inline mention from a text field, keeping the human
 *  label: `[label](block:<id>)` → `label`; any bare `block:<id>` / `|<id>` token
 *  is dropped. Used when clearing a link whose target no longer exists. */
function stripLinkFromText(text: string, target: string): string {
  const esc = escapeRe(target);
  const mention = new RegExp(String.raw`\[((?:\\.|[^\]\\])*)\]\(block:${esc}\)`, "g");
  return text
    .replace(mention, (_m, label: string) => label.replace(/\\([[\]\\])/g, "$1"))
    .replace(new RegExp(String.raw`\|${esc}`, "g"), "")
    .replace(new RegExp(`block:${esc}`, "g"), "");
}

/** Rewrite mention text in every block matching any LIKE pattern: used when a
 * title or tag is renamed so raw `@Name`/`#tag` tokens and markdown mention
 * labels stay in sync. Bumps versions and re-queues embeddings. */
async function rewriteReferences(
  userId: string,
  excludeId: string | null,
  likePatterns: string[],
  fn: (s: string) => string,
): Promise<number> {
  if (!likePatterns.length) return 0;
  const arms = likePatterns.flatMap((pat) => [
    sql`${blocks.properties}::text LIKE ${`%${pat}%`}`,
    sql`${blocks.content} LIKE ${`%${pat}%`}`,
  ]);
  const rows = await db
    .select({
      id: blocks.id,
      blockTypeId: blocks.blockTypeId,
      properties: blocks.properties,
      content: blocks.content,
    })
    .from(blocks)
    .where(
      and(
        eq(blocks.ownerId, userId),
        excludeId ? sql`${blocks.id} <> ${excludeId}` : sql`true`,
        or(...arms),
      ),
    )
    .limit(500);
  let changed = 0;
  const typeCache = new Map<string, Awaited<ReturnType<typeof resolveType>>>();
  for (const row of rows) {
    const nextProps = rewriteStrings(row.properties, fn) as Record<string, unknown>;
    const nextContent = typeof row.content === "string" ? fn(row.content) : row.content;
    if (JSON.stringify(nextProps) === JSON.stringify(row.properties) && nextContent === row.content) continue;
    let type;
    try {
      if (row.blockTypeId) {
        type = typeCache.get(row.blockTypeId) ?? (await resolveType(userId, row.blockTypeId));
        typeCache.set(row.blockTypeId, type);
      } else {
        type = await resolveType(userId, undefined);
      }
    } catch {
      continue;
    }
    const embedSource = computeEmbedSource(type, { content: nextContent, properties: nextProps });
    await db
      .update(blocks)
      .set({
        properties: nextProps,
        content: nextContent,
        embedSource,
        embedSourceHash: null, // re-embed with the corrected text
        version: sql`${blocks.version} + 1`,
        // Deliberately does NOT stamp `updated_at`. Nobody edited these notes:
        // they named something whose name changed, and this is the app keeping
        // its own references true. Stamping it said otherwise, and loudly —
        // rename one block, or turn one placeholder into a real one, and every
        // note that ever mentioned it claimed to have been edited today, which
        // is how a day's "created or edited" filled up with things last touched
        // weeks ago.
        //
        // `version` still moves: the text really did change, and an editor
        // holding the old one has to be told rather than allowed to write the
        // old label back over it.
      })
      .where(and(eq(blocks.id, row.id), eq(blocks.ownerId, userId)));
    changed++;
  }
  return changed;
}

/** A block's title changed: update raw `@Old_Title` tokens and the labels of
 * markdown `[label](block:<id>)` links that point at it. Bookkeeping, so the
 * notes doing the pointing aren't marked as edited — see rewriteReferences. */
async function propagateTitleRename(
  userId: string,
  blockId: string,
  oldTitle: string,
  newTitle: string,
): Promise<number> {
  const from = oldTitle.trim();
  const to = newTitle.trim();
  if (!from || !to || from === to) return 0;
  const oldTok = `@${from.replace(/ /g, "_")}`;
  const newTok = `@${to.replace(/ /g, "_")}`;
  const tokRe = new RegExp(`${escapeRe(oldTok)}(?![\\w-])`, "g");
  const labelRe = new RegExp(`\\[[^\\]]*\\]\\(block:${escapeRe(blockId)}\\)`, "g");
  return rewriteReferences(userId, blockId, [oldTok, `](block:${blockId})`], (s) =>
    s.replace(tokRe, newTok).replace(labelRe, `[${to}](block:${blockId})`),
  );
}

/**
 * Add tags for `#` mentions present in a block's text. Add-only: removing a
 * mention from the text does NOT remove the tag (that stays a manual action),
 * which avoids provenance edge cases. Returns whether anything was added.
 */
async function syncTextTags(
  userId: string,
  blockId: string,
  texts: string[],
  rawTexts: string[] = [],
): Promise<boolean> {
  const names = extractTags(texts, rawTexts);
  if (names.size === 0) return false;
  let changed = false;
  await db.transaction(async (tx) => {
    for (const name of names) {
      await tx.insert(tags).values({ ownerId: userId, name }).onConflictDoNothing();
      const [t] = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.ownerId, userId), eq(tags.name, name)))
        .limit(1);
      if (!t) continue;
      const r = await tx
        .insert(blockTags)
        .values({ blockId, tagId: t.id })
        .onConflictDoNothing()
        .returning({ tagId: blockTags.tagId });
      if (r.length) changed = true;
    }
  });
  return changed;
}

/**
 * When a recurring task transitions to complete, spawn the next occurrence: a
 * copy with the status reset and the schedule datespan advanced per the rule.
 * Returns whether a new block was created.
 */
async function spawnRecurrence(
  userId: string,
  type: { id: string; schemaVersion: number; propertySchema: PropertySchema | null },
  prevProps: Record<string, unknown>,
  nextProps: Record<string, unknown>,
  /** The occurrence being completed: the new one joins its series. */
  from: { id: string; seriesId: string | null },
): Promise<boolean> {
  const schema = type.propertySchema;
  if (!schema?.status_field) return false;
  if (!(isComplete(schema, nextProps) && !isComplete(schema, prevProps))) return false;

  const recField = schema.fields.find((f) => f.type === "recurrence");
  const spanField = schema.fields.find((f) => f.type === "datespan");
  if (!recField || !spanField) return false;

  // The rule comes from the series. syncSeries has already written it there from
  // whatever this update stored, so this reads the same value the property holds
  // — which is the point of doing the sync first: moving a reader across is a
  // change that can be checked rather than one that has to be trusted.
  const [linked] = from.seriesId
    ? await db.select({ rule: series.rule }).from(series).where(eq(series.id, from.seriesId))
    : [];
  const parsed = recurrenceSchema.safeParse(linked?.rule ?? nextProps[recField.key]);
  if (!parsed.success) return false;
  const rec = parsed.data;

  const span = (nextProps[spanField.key] ?? {}) as { start?: string; end?: string };
  const now = new Date();
  const completedOn = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const next = nextSpan(span, rec, completedOn);
  if (!next?.end) return false;

  // Creating a series is syncSeries' job and only syncSeries' job — it runs on
  // every write, including the one that completed this task, so a block with a
  // rule already has one by the time it gets here. Two places minting series
  // would be the same duplication this whole change is removing, one level up.
  const seriesId = from.seriesId;

  // Where this occurrence sits in its series. Counted from the instances, which
  // is what the count is about — but never less than the counter the rule has
  // been carrying, so a series with history behind it keeps its place instead of
  // restarting at one. `n` is still written for the surfaces that read it; the
  // count is what decides.
  const [counted] = seriesId
    ? await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(blocks)
        .where(and(eq(blocks.ownerId, userId), eq(blocks.seriesId, seriesId)))
    : [];
  const currentN = Math.max(counted?.n ?? 0, rec.n ?? 1);
  if (!recurrenceContinues(rec, currentN, next.end)) return false;

  // `nextProps` has already been through `stampDoneAt`, so it carries the moment
  // the *previous* occurrence was finished. That belongs to the task being
  // completed, not to the fresh one, which has never been done.
  const { done_at: _prevDone, ...carried } = nextProps;
  const copyProps: Record<string, unknown> = {
    ...carried,
    [schema.status_field]: schema.default_value ?? null,
    [spanField.key]: next,
    [recField.key]: {
      ...rec,
      n: currentN + 1,
      // Pin the day a monthly or yearly series recurs on, from the occurrence
      // being completed, if nobody has said yet. A rule written before this
      // existed reads its day off whichever occurrence is in hand — and once a
      // short February has clamped one, that reads as the 28th and the series
      // never climbs back. Stamping it here stops the drift where it stands. It
      // does not undo drift that already happened: the day it originally meant
      // was never written down anywhere, and guessing at it would be inventing.
      ...(rec.monthDay === undefined && (rec.frequency === "monthly" || rec.frequency === "yearly")
        ? { monthDay: Number(String(span?.end ?? span?.start ?? "").slice(8, 10)) || undefined }
        : {}),
    },
  };
  const embedSource = computeEmbedSource(
    { isText: false, propertySchema: schema },
    { content: null, properties: copyProps },
  );
  await db.insert(blocks).values({
    ownerId: userId,
    blockTypeId: type.id,
    content: null,
    properties: copyProps,
    embedSource,
    embedSourceHash: null,
    blockTypeSchemaVersion: type.schemaVersion,
  });
  return true;
}

/** Resolve a block type for this owner, defaulting to the seeded `text` type. */
async function resolveType(ownerId: string, blockTypeId?: string) {
  const where = blockTypeId
    ? and(eq(blockTypes.id, blockTypeId), eq(blockTypes.ownerId, ownerId))
    : and(eq(blockTypes.ownerId, ownerId), eq(blockTypes.name, "text"));
  const [row] = await db.select().from(blockTypes).where(where).limit(1);
  if (!row) throw badRequest(blockTypeId ? "unknown block type" : "text block type missing");
  return row;
}

const blockView = {
  id: blocks.id,
  blockTypeId: blocks.blockTypeId,
  collectionKind: blocks.collectionKind,
  content: blocks.content,
  properties: blocks.properties,
  embeddedAt: blocks.embeddedAt,
  embedPending: sql<boolean>`(${blocks.embedSourceHash} IS NULL AND ${blocks.embedSource} IS NOT NULL)`,
  version: blocks.version,
  archivedAt: blocks.archivedAt,
  createdAt: blocks.createdAt,
  updatedAt: blocks.updatedAt,
};

/** A template's text, or "" — a template deleted since being assigned is
 *  simply nothing to start from, not an error at the moment of writing. */
export async function templateBody(userId: string, id: unknown): Promise<string> {
  if (typeof id !== "string" || !id) return "";
  const [row] = await db
    .select({ content: blocks.content, properties: blocks.properties })
    .from(blocks)
    .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
    .limit(1);
  if (!row || !(TEMPLATE_MARKER in (row.properties ?? {}))) return "";
  return row.content ?? "";
}

/**
 * A column read as prose: markdown mention links reduced to their labels, so a
 * search phrase can run from ordinary words into a link and still match.
 * `[Sherly](block:…)` becomes `Sherly`; anything that isn't a mention scheme is
 * left alone, so ordinary markdown links keep their URLs searchable.
 */
const flatten = (col: SQL | SQLWrapper) =>
  sql`regexp_replace(
    regexp_replace(COALESCE(${col}, ''), '</?mark[^>]*>', '', 'g'),
    '\\[([^]]*)\\]\\((block|tag|person|new|fwd):[^)]*\\)', '\\1', 'g'
  )`;

/** Reusable predicate: the block is active (not archived). */
const notArchived = sql`${blocks.archivedAt} IS NULL`;

/**
 * Upper bound on a free-text search term. A real query is a few words; anything
 * longer is abuse — it would blow up the `ILIKE '%…%'` scan and, for semantic
 * search, the embedding call. Reused by every `q`-style query param below.
 */
const searchTerm = z.string().max(256);

/**
 * Stamp `done_at` when a block's status crosses into a complete value, and clear
 * it when it leaves — so auto-archive can measure "how long has this been done".
 * Returns the same object when nothing changes.
 */
function stampDoneAt(
  schema: PropertySchema | null | undefined,
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema?.status_field) return next;
  const wasDone = isComplete(schema, prev);
  const nowDone = isComplete(schema, next);
  if (nowDone && !wasDone) return { ...next, done_at: new Date().toISOString() };
  if (!nowDone && next.done_at != null) {
    const { done_at: _drop, ...rest } = next;
    return rest;
  }
  return next;
}

/**
 * After a hard-delete, clean the references that FK cascade can't reach because
 * they live in JSONB, not FK columns: canvas edges/regions, today-layout
 * sections, the cross-day today_default, and weekly-review step links. (Textual
 * `block:<id>` links in bodies are left to degrade gracefully at render time.)
 */
async function scrubDanglingRefs(userId: string, id: string): Promise<void> {
  // Canvas edges + region memberships on every canvas the user owns.
  const canvases = await db
    .select({ id: blocks.id, properties: blocks.properties })
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), eq(blocks.collectionKind, "canvas")));
  for (const c of canvases) {
    const p = (c.properties ?? {}) as Record<string, unknown>;
    const edges = Array.isArray(p.canvas_edges) ? (p.canvas_edges as { from?: string; to?: string }[]) : [];
    const regions = Array.isArray(p.canvas_regions)
      ? (p.canvas_regions as { memberIds?: string[] }[])
      : [];
    const nextEdges = edges.filter((e) => e.from !== id && e.to !== id);
    const nextRegions = regions.map((r) =>
      Array.isArray(r.memberIds) ? { ...r, memberIds: r.memberIds.filter((m) => m !== id) } : r,
    );
    if (nextEdges.length !== edges.length || JSON.stringify(nextRegions) !== JSON.stringify(regions)) {
      await db
        .update(blocks)
        .set({
          properties: { ...p, canvas_edges: nextEdges, canvas_regions: nextRegions },
          version: sql`${blocks.version} + 1`,
        })
        .where(and(eq(blocks.id, c.id), eq(blocks.ownerId, userId)));
    }
  }

  // Today-layout sections on daily notes (a custom section is { t, id }).
  const notes = await db
    .select({ id: blocks.id, properties: blocks.properties })
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), sql`jsonb_exists(${blocks.properties}, 'layout')`));
  for (const n of notes) {
    const p = (n.properties ?? {}) as Record<string, unknown>;
    const layout = Array.isArray(p.layout) ? (p.layout as unknown[]) : [];
    const next = layout.filter((s) => !(s && typeof s === "object" && (s as { id?: string }).id === id));
    if (next.length !== layout.length) {
      await db
        .update(blocks)
        .set({ properties: { ...p, layout: next }, version: sql`${blocks.version} + 1` })
        .where(and(eq(blocks.id, n.id), eq(blocks.ownerId, userId)));
    }
  }

  // Cross-day today_default + weekly-review step links in user settings.
  const [settings] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (settings) {
    const prefs = { ...(settings.preferences ?? {}) } as Record<string, unknown>;
    let changed = false;
    if (Array.isArray(prefs.today_default)) {
      const arr = prefs.today_default as { section?: { id?: string } }[];
      const kept = arr.filter((e) => e?.section?.id !== id);
      if (kept.length !== arr.length) {
        prefs.today_default = kept;
        changed = true;
      }
    }
    // Weekly-review step links are deliberately NOT scrubbed: a step carries a
    // user-authored description, so a dead link is left to degrade at render
    // (the review page shows a "no longer exists — remove or relink" placeholder)
    // rather than silently deleting the step.
    if (changed)
      await db.update(userSettings).set({ preferences: prefs }).where(eq(userSettings.userId, userId));
  }
}

export async function blockRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Create a block of any type. Text types embed content; typed blocks derive
  // embed_source from their properties. Left stale for the embedding worker.
  app.post("/blocks", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        /**
         * The block's id, when the caller has one to give.
         *
         * For a client that can be interrupted mid-request — anything writing
         * over a network it doesn't control — a server-minted id is the one
         * thing it can't recover from. If the response is lost in flight there
         * is no local fact that separates "it never landed" from "it landed and
         * I didn't hear": retrying makes two blocks, not retrying loses one.
         * Naming the id up front settles it, because a repeat of the same
         * create is then recognisably the same create.
         */
        id: z.string().uuid().optional(),
        blockTypeId: z.string().uuid().optional(),
        content: z.string().optional(),
        properties: z.record(z.unknown()).optional(),
      })
      .parse(req.body);

    const type = await resolveType(userId, body.blockTypeId);
    const content = type.isText ? body.content ?? "" : null;
    // Seed schema defaults (e.g. the status field's default_value) on creation.
    const defaults: Record<string, unknown> = {};
    const schema = type.propertySchema;
    if (!type.isText && schema?.status_field && schema.default_value != null) {
      defaults[schema.status_field] = schema.default_value;
    }
    const properties = type.isText ? {} : { ...defaults, ...(body.properties ?? {}) };
    // A field that names a template starts from it, unless the caller has
    // already said what goes there.
    for (const f of schema?.fields ?? []) {
      if (f.type !== "longtext" || !f.templateId) continue;
      if (properties[f.key] != null && properties[f.key] !== "") continue;
      const body2 = await templateBody(userId, f.templateId);
      if (body2) properties[f.key] = body2;
    }
    const embedSource = computeEmbedSource(type, { content, properties });

    const [row] = await db
      .insert(blocks)
      .values({
        ...(body.id ? { id: body.id } : {}),
        ownerId: userId,
        blockTypeId: type.id,
        content,
        properties,
        embedSource,
        embedSourceHash: null,
        blockTypeSchemaVersion: type.schemaVersion,
      })
      // Nothing to conflict with when the id is ours to mint. When it isn't,
      // this is what makes a repeated create idempotent — and it settles the
      // race between two of them arriving at once, which checking first and
      // then inserting would not.
      .onConflictDoNothing()
      .returning(blockView);
    if (row) {
      // A task created already repeating gets its series now, so it is a
      // recurrence to anyone reading rather than only after its first
      // completion.
      await syncSeries(userId, row.id, null, type.propertySchema, (row.properties ?? {}) as Record<string, unknown>);
      reply.code(201);
      return row;
    }
    // The id was already taken. Answer with the block if it's this caller's —
    // the create already happened, which is what they were asking for. If it
    // isn't theirs, say the id is taken and nothing more: whose it is, and what
    // it holds, is not theirs to learn.
    const [existing] = await db
      .select(blockView)
      .from(blocks)
      .where(and(eq(blocks.id, body.id!), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!existing) throw conflict("that id is already in use");
    return existing;
  });

  /**
   * Templates: named prose to drop into any long-text field.
   *
   * They're text blocks wearing a marker rather than a new kind of thing, so
   * they edit with the ordinary markdown surface and everything that surface
   * can do — mentions included — keeps working once one has been applied.
   * Being system blocks, they're kept out of the listings and queries the way
   * daily notes are.
   */
  app.get("/templates", async (req) => {
    const userId = requireUser(req);
    return db
      .select(blockView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          notArchived,
          sql`jsonb_exists(${blocks.properties}, ${TEMPLATE_MARKER})`,
        ),
      )
      .orderBy(sql`lower(${blocks.properties}->>${TEMPLATE_MARKER})`);
  });

  app.post("/templates", async (req, reply) => {
    const userId = requireUser(req);
    const { name, content } = z
      .object({ name: z.string().min(1).max(120), content: z.string().max(20000).optional() })
      .parse(req.body);
    const [textType] = await db
      .select({ id: blockTypes.id, schemaVersion: blockTypes.schemaVersion })
      .from(blockTypes)
      .where(and(eq(blockTypes.ownerId, userId), eq(blockTypes.isText, true)))
      .orderBy(desc(blockTypes.builtin))
      .limit(1);
    if (!textType) throw badRequest("text block type missing");
    const body = content ?? "";
    const [row] = await db
      .insert(blocks)
      .values({
        ownerId: userId,
        blockTypeId: textType.id,
        content: body,
        properties: { [TEMPLATE_MARKER]: name.trim(), title: name.trim() },
        embedSource: "",
        embedSourceHash: null,
        blockTypeSchemaVersion: textType.schemaVersion,
      })
      .returning(blockView);
    reply.code(201);
    return row;
  });

  /** Rename or rewrite one. Deleting is the ordinary block delete. */
  app.patch("/templates/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { name, content } = z
      .object({
        name: z.string().min(1).max(120).optional(),
        content: z.string().max(20000).optional(),
      })
      .parse(req.body);
    const [current] = await db
      .select({ properties: blocks.properties })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!current || !(TEMPLATE_MARKER in (current.properties ?? {}))) throw notFound("template");
    const props = { ...current.properties };
    if (name !== undefined) {
      props[TEMPLATE_MARKER] = name.trim();
      props.title = name.trim();
    }
    const [row] = await db
      .update(blocks)
      .set({
        properties: props,
        ...(content !== undefined ? { content } : {}),
        version: sql`${blocks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .returning(blockView);
    return row;
  });

  /** A template is only ever deleted outright — it's not filed anywhere to
   *  archive it from, and an archived one nobody can reach is just clutter. */
  app.delete("/templates/:id", async (req, reply) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (req.authKind !== "cookie") throw forbidden("deleting requires a browser session");
    const [row] = await db
      .select({ properties: blocks.properties })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!row || !(TEMPLATE_MARKER in (row.properties ?? {}))) throw notFound("template");
    await db.delete(blocks).where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)));
    reply.code(204);
    return null;
  });
  /**
   * Turn a placeholder into a real block.
   *
   * A placeholder is a mention of something that doesn't exist yet — written
   * as `new:<label>` because at the time of writing nobody knew, or cared,
   * what kind of thing it would turn out to be. Naming it is one thought;
   * deciding it's a Project is another, and often a later one.
   *
   * Realizing it creates the block and rewrites every mention of that
   * placeholder to point at it — the same sweep a title rename uses. The same
   * name may have been written in a dozen notes; they all meant the one thing.
   */
  app.post("/blocks/placeholder", async (req, reply) => {
    const userId = requireUser(req);
    const { label, blockTypeId } = z
      .object({ label: z.string().min(1).max(200), blockTypeId: z.string().uuid().optional() })
      .parse(req.body);

    const type = await resolveType(userId, blockTypeId);
    // The name it goes by, and the name it was written down as, are not always
    // the same string: the mention trigger can't take a space, so a two-word
    // name had to be typed with an underscore. That's typing, not naming — the
    // block gets the spaced form, while the token below keeps the written one,
    // since that's what the notes carrying it actually say.
    const written = label.trim();
    const title = written.replace(/_/g, " ");
    const content = type.isText ? title : null;
    const properties = type.isText ? {} : { title };
    const [row] = await db
      .insert(blocks)
      .values({
        ownerId: userId,
        blockTypeId: type.id,
        content,
        properties,
        embedSource: computeEmbedSource(type, { content, properties }),
        embedSourceHash: null,
        blockTypeSchemaVersion: type.schemaVersion,
      })
      .returning(blockView);
    if (!row) throw badRequest("could not create the block");

    // The href carries the label percent-encoded, so a name with a bracket or a
    // paren in it can't break the markdown link it lives inside.
    const token = `](new:${encodeURIComponent(written)})`;
    // Which blocks carried it, gathered before the sweep so the client can tell
    // their editors to reread — otherwise a note still holding the old text
    // would save the placeholder straight back over the rewrite.
    const carriers = await db
      .select({ id: blocks.id })
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          or(
            sql`${blocks.properties}::text LIKE ${`%${token}%`}`,
            sql`${blocks.content} LIKE ${`%${token}%`}`,
          ),
        ),
      );
    await rewriteReferences(userId, row.id, [token], (str) =>
      str.split(token).join(`](block:${row.id})`),
    );
    reply.code(201);
    return { block: row, rewritten: carriers.map((c) => c.id) };
  });

  /**
   * Everything dated within a range, whatever type it is.
   *
   * A calendar collection shows what belongs to it. This answers the other
   * question a day view asks — what else is happening then — across every type
   * that carries a date at all, so a day can be read as a day rather than as
   * one collection's slice of it.
   *
   * Scanned rather than queried: "any dated field touches these days" isn't
   * something the filter language can say, since a datespan is an object and the
   * key it lives under is named by each type for itself. The range is small (a
   * day or three), the candidate cap is the same one the Today sheet uses, and
   * the alternative is asking every type its own question.
   */
  app.get("/blocks/dated", async (req) => {
    const userId = requireUser(req);
    const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const { start, end } = z.object({ start: DAY, end: DAY }).parse(req.query);
    if (end < start) throw badRequest("end is before start");

    const types = await db
      .select({ id: blockTypes.id, propertySchema: blockTypes.propertySchema })
      .from(blockTypes)
      .where(eq(blockTypes.ownerId, userId));
    const schemaById = new Map(types.map((t) => [t.id, t.propertySchema]));

    const candidates = await db
      .select(blockView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NULL`,
          sql`${blocks.archivedAt} IS NULL`,
        ),
      )
      .limit(2000);

    return candidates.filter((b) =>
      datedInRange(
        b.blockTypeId ? schemaById.get(b.blockTypeId) ?? null : null,
        (b.properties ?? {}) as Record<string, unknown>,
        start,
        end,
      ),
    );
  });

  /**
   * Unattached: blocks that nothing hangs off of — no parent, no children, and
   * not referenced (via a reference property) by any other block. Outgoing
   * references do NOT count: a block that only points at others still appears
   * here. Scoped to the owner; collections (collection_kind set) are exempt.
   */
  app.get("/blocks/unattached", async (req) => {
    const userId = requireUser(req);
    return db
      .select(blockView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NULL`,
          sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
      sql`NOT jsonb_exists(${blocks.properties}, ${TEMPLATE_MARKER})`,
          notArchived,
          // no parent (not a member of any collection)
          sql`NOT EXISTS (SELECT 1 FROM ${memberships} m WHERE m.block_id = ${blocks.id})`,
          // no children (not a collection with members)
          sql`NOT EXISTS (SELECT 1 FROM ${memberships} m WHERE m.collection_id = ${blocks.id})`,
          // not referenced by another block: this block's id appears anywhere in
          // another block's properties (reference fields store the target id, as
          // a scalar or an array element for multi-references).
          sql`NOT EXISTS (
            SELECT 1 FROM ${blocks} ref
            WHERE ref.owner_id = ${userId} AND ref.id <> ${blocks.id}
              AND jsonb_path_exists(ref.properties, '$.** ? (@ == $id)', jsonb_build_object('id', ${blocks.id}::text))
          )`,
        ),
      )
      .orderBy(desc(blocks.updatedAt));
  });

  /**
   * All blocks, optionally filtered by a query. Empty filter returns every
   * (non-collection) block. Powers the "All blocks" view and its query builder.
   */
  app.post("/blocks/query", async (req) => {
    const userId = requireUser(req);
    const { filterQuery, archived, asOf, withCount } = z
      .object({
        filterQuery: filterQuerySchema.optional(),
        archived: z.boolean().optional(),
        // The day to treat as "today" — a Today page's own date, so what it
        // embeds reads as of that day (see runQuery).
        asOf: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        /** Answer as { blocks, total, limit } instead of a bare array. */
        withCount: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const counted = await runQueryCounted(userId, normalizeFilter(filterQuery), archived ?? false, asOf);
    const matched = counted.rows;
    const rows = matched.map((b) => ({
      id: b.id,
      blockTypeId: b.blockTypeId,
      collectionKind: null,
      content: b.content,
      properties: b.properties,
      embeddedAt: null,
      embedPending: false,
      version: b.version,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
    // The array shape is what every existing caller expects; a caller that wants
    // to know whether it's looking at all of them asks for the count.
    return withCount ? { blocks: rows, total: counted.total, limit: counted.limit } : rows;
  });

  /**
   * Blocks of a given type (for the Types page), newest-edited first. An
   * optional `q` matches title / description / body content, plus semantic
   * similarity above the account's default threshold (no per-query slider here).
   */
  app.get("/blocks/of-type/:typeId", async (req) => {
    const userId = requireUser(req);
    const { typeId } = z.object({ typeId: z.string().uuid() }).parse(req.params);
    const { q } = z.object({ q: searchTerm.optional() }).parse(req.query);

    const filters = [
      eq(blocks.ownerId, userId),
      eq(blocks.blockTypeId, typeId),
      sql`${blocks.collectionKind} IS NULL`,
      sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
      sql`NOT jsonb_exists(${blocks.properties}, ${TEMPLATE_MARKER})`,
      notArchived,
    ];
    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      const [s] = await db
        .select({ sim: userSettings.defaultSimilarity })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
      const ids = await semanticIds(userId, q.trim(), s?.sim ?? 0.75);
      const textMatch = sql`(${blocks.properties}->>'title' ILIKE ${like} OR ${blocks.properties}->>'description' ILIKE ${like} OR ${blocks.content} ILIKE ${like})`;
      filters.push(ids.length ? or(textMatch, inArray(blocks.id, ids))! : textMatch);
    }

    return db
      .select(blockView)
      .from(blocks)
      .where(and(...filters))
      .orderBy(desc(blocks.updatedAt))
      .limit(200);
  });

  // Options for a reference field: blocks of a given type, as {id, label}.
  // Optional `q` filters by title/content for a dynamic search box.
  app.get("/blocks/references", async (req) => {
    const userId = requireUser(req);
    const { typeId, q } = z
      .object({ typeId: z.string().uuid(), q: searchTerm.optional() })
      .parse(req.query);
    const filters = [
      eq(blocks.ownerId, userId),
      eq(blocks.blockTypeId, typeId),
      sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
      sql`NOT jsonb_exists(${blocks.properties}, ${TEMPLATE_MARKER})`,
      notArchived,
    ];
    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      filters.push(
        sql`(${blocks.properties}->>'title' ILIKE ${like} OR ${blocks.content} ILIKE ${like})`,
      );
    }
    const rows = await db
      .select({ id: blocks.id, properties: blocks.properties, content: blocks.content })
      .from(blocks)
      .where(and(...filters))
      .orderBy(desc(blocks.updatedAt))
      .limit(25);
    return rows.map((r) => ({
      id: r.id,
      label: oneLineLabel(r.properties as Record<string, unknown>, r.content) || "Untitled",
    }));
  });

  // Search existing (non-collection) blocks to add to a collection.
  /**
   * Global dynamic search (top-bar): blocks, collections, AND daily notes,
   * matching the title, body content, or any property value — followed by
   * semantic matches (embedding similarity at the account's default floor)
   * that the literal search missed.
   */
  app.get("/search", async (req) => {
    const userId = requireUser(req);
    const { q } = z.object({ q: searchTerm }).parse(req.query);
    const term = q.trim();
    if (!term) return [];
    const like = `%${term}%`;
    const cols = {
      id: blocks.id,
      blockTypeId: blocks.blockTypeId,
      collectionKind: blocks.collectionKind,
      properties: blocks.properties,
      content: blocks.content,
    };
    const toHit = (r: {
      id: string;
      blockTypeId: string | null;
      collectionKind: string | null;
      properties: unknown;
      content: string | null;
    }, semantic: boolean) => {
      const props = r.properties as Record<string, unknown>;
      const today = typeof props?.today_note === "string" ? (props.today_note as string) : null;
      return {
        id: r.id,
        kind: today ? ("today" as const) : r.collectionKind ? ("collection" as const) : ("block" as const),
        date: today ?? undefined,
        blockTypeId: r.blockTypeId,
        label: oneLineLabel(props, r.content) || "Untitled",
        document: r.collectionKind === "document",
        matrix: r.collectionKind === "matrix",
        table: r.collectionKind === "table",
        canvas: r.collectionKind === "canvas",
        calendar: r.collectionKind === "calendar",
        rollup: r.collectionKind === "rollup",
        smart: props?.membership_mode === "smart",
        semantic,
      };
    };

    const rows = await db
      .select(cols)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          notArchived,
          // Search the text as it reads, not as it's stored. A mention is written
          // `[Sherly](block:…)`, so "Tell Sherly" — a phrase that runs from plain
          // words into a link — matched nothing, though it's exactly what the
          // sentence says. Both forms are tried: the flattened one finds phrases
          // that cross a mention, the raw one still finds an id pasted verbatim.
          sql`(
            ${blocks.properties}::text ILIKE ${like}
            OR ${blocks.content} ILIKE ${like}
            OR ${flatten(blocks.content)} ILIKE ${like}
            OR ${flatten(sql`${blocks.properties}::text`)} ILIKE ${like}
          )`,
        ),
      )
      .orderBy(desc(blocks.updatedAt))
      .limit(20);
    const literal = rows.map((r) => toHit(r, false));

    // Semantic follow-ups the literal search missed.
    const [s] = await db
      .select({ sim: userSettings.defaultSimilarity })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    const semIds = await semanticIds(userId, term, s?.sim ?? 0.75);
    const seen = new Set(literal.map((h) => h.id));
    const fresh = [...new Set(semIds)].filter((id) => !seen.has(id)).slice(0, 50);
    let semantic: ReturnType<typeof toHit>[] = [];
    if (fresh.length) {
      const srows = await db
        .select(cols)
        .from(blocks)
        .where(and(eq(blocks.ownerId, userId), notArchived, inArray(blocks.id, fresh)))
        .orderBy(desc(blocks.updatedAt))
        .limit(10);
      semantic = srows.map((r) => toHit(r, true));
    }
    return [...literal, ...semantic];
  });

  app.get("/blocks/search", async (req) => {
    const userId = requireUser(req);
    const { q, typeId, excludeCollectionId, includeCollections } = z
      .object({
        q: searchTerm.optional(),
        typeId: z.string().uuid().optional(),
        excludeCollectionId: z.string().uuid().optional(),
        includeCollections: z.coerce.boolean().optional(),
      })
      .parse(req.query);

    const filters = [
      eq(blocks.ownerId, userId),
      sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
      sql`NOT jsonb_exists(${blocks.properties}, ${TEMPLATE_MARKER})`,
      notArchived,
    ];
    if (!includeCollections) filters.push(sql`${blocks.collectionKind} IS NULL`);
    if (typeId) filters.push(eq(blocks.blockTypeId, typeId));
    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      filters.push(
        sql`(${blocks.properties}->>'title' ILIKE ${like} OR ${blocks.content} ILIKE ${like})`,
      );
    }
    if (excludeCollectionId) {
      filters.push(
        sql`NOT EXISTS (SELECT 1 FROM ${memberships} m WHERE m.block_id = ${blocks.id} AND m.collection_id = ${excludeCollectionId})`,
      );
    }

    const rows = await db
      .select({
        id: blocks.id,
        blockTypeId: blocks.blockTypeId,
        collectionKind: blocks.collectionKind,
        properties: blocks.properties,
        content: blocks.content,
      })
      .from(blocks)
      .where(and(...filters))
      .orderBy(desc(blocks.updatedAt))
      .limit(30);

    return rows.map((r) => ({
      id: r.id,
      blockTypeId: r.blockTypeId,
      collectionKind: r.collectionKind,
      label: oneLineLabel(r.properties as Record<string, unknown>, r.content) || "Untitled",
    }));
  });

  /**
   * What hangs off a set of blocks — one level of a rollup, for every parent at
   * that level at once.
   *
   * Two ways to belong under a parent, and a level may ask for either or both:
   * a reference field on the child holding the parent's id (a task's `project`),
   * and — when the parent is a collection — its membership. Answered as edges
   * rather than a grouped map because a block can hang off more than one parent,
   * and losing that would silently drop it from all but one.
   *
   * One query per level, not one per parent: a hundred projects is one round
   * trip, not a hundred.
   */
  app.post("/blocks/children", async (req) => {
    const userId = requireUser(req);
    const { parents, typeId, refKey, members } = z
      .object({
        parents: z.array(z.string().uuid()).max(500),
        typeId: z.string().uuid().nullish(),
        refKey: z.string().min(1).nullish(),
        members: z.boolean().optional(),
      })
      .parse(req.body);
    if (parents.length === 0) return { edges: [] };

    const cols = {
      id: blocks.id,
      blockTypeId: blocks.blockTypeId,
      collectionKind: blocks.collectionKind,
      content: blocks.content,
      properties: blocks.properties,
      version: blocks.version,
      createdAt: blocks.createdAt,
      updatedAt: blocks.updatedAt,
    };
    const typeFilter = typeId ? eq(blocks.blockTypeId, typeId) : sql`TRUE`;

    // Everything pointing at ANY of these parents, in one pass. A reference
    // field holds either one id or a list of them, so both shapes are checked;
    // without a named field every property counts, which is what "connected to
    // it, however you connected it" means.
    const keyFilter = refKey ? sql`e.key = ${refKey}` : sql`TRUE`;
    // The parents travel as one json parameter rather than an array one: it
    // binds as plain text, so there's no array type for the driver and the
    // planner to agree about on the way in.
    const parentSet = sql`(SELECT jsonb_array_elements_text(${JSON.stringify(parents)}::jsonb))`;
    const pointing = await db
      .select(cols)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          notArchived,
          typeFilter,
          sql`EXISTS (
            SELECT 1 FROM jsonb_each(${blocks.properties}) e
            WHERE ${keyFilter}
              AND (
                (jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = ANY${parentSet})
                OR (jsonb_typeof(e.value) = 'array' AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(e.value) AS x(v)
                  WHERE x.v = ANY${parentSet}
                ))
              )
          )`,
        ),
      );

    // Which of them it points at is read back off the properties we already
    // have: the row is here because it names at least one parent, and a block
    // that names two belongs under both.
    const wanted = new Set(parents);
    const byRef = pointing.flatMap((row) => {
      const hits = new Set<string>();
      for (const [key, value] of Object.entries(row.properties ?? {})) {
        if (refKey && key !== refKey) continue;
        for (const v of Array.isArray(value) ? value : [value]) {
          if (typeof v === "string" && v !== row.id && wanted.has(v)) hits.add(v);
        }
      }
      return [...hits].map((parentId) => ({ parentId, ...row }));
    });

    let byMember: typeof byRef = [];
    if (members) {
      byMember = await db
        .select({ parentId: sql<string>`${memberships.collectionId}::text`.as("parent_id"), ...cols })
        .from(memberships)
        .innerJoin(
          blocks,
          and(eq(blocks.id, memberships.blockId), eq(blocks.ownerId, userId), notArchived, typeFilter),
        )
        .where(inArray(memberships.collectionId, parents))
        .orderBy(asc(memberships.position));
    }

    // Both routes can name the same pair; the child appears under its parent once.
    const seen = new Set<string>();
    const edges = [...byRef, ...byMember].filter((r) => {
      const k = `${r.parentId}|${r.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { edges };
  });

  app.get("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .select(blockView)
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!row) throw notFound("block");
    return row;
  });

  /** Connection graph out to N generations (graph panel). */
  app.get("/blocks/:id/graph", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { depth } = z.object({ depth: z.coerce.number().int().min(1).max(5).default(1) }).parse(req.query);
    try {
      return await buildGraph(userId, id, depth);
    } catch {
      throw notFound("block");
    }
  });

  /**
   * Everything connected to a block, in full.
   *
   * The graph panel's first ring, answered as blocks rather than as labelled
   * dots: whatever a project's page shows underneath it has to be sortable by
   * the properties of the things in it, and a node with an icon and a name is
   * not enough to sort by a due date.
   *
   * The relationship model is the graph's, which is the info pane's — reference
   * fields, `block:`/`|` links, `@name` mentions in both directions, collection
   * membership (including smart collections that store no membership rows), and
   * canvas edges. `/blocks/children` deliberately sees less than this: it is a
   * rollup level, and a rollup follows a named field down a hierarchy. "What is
   * this connected to" is a different question and wants every answer.
   */
  app.get("/blocks/:id/connected", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    let graph;
    try {
      graph = await buildGraph(userId, id, 1);
    } catch {
      throw notFound("block");
    }
    const ids = graph.nodes.filter((n) => n.gen === 1).map((n) => n.id);
    if (!ids.length) return { blocks: [], truncated: graph.truncated };
    // Archived neighbours are left out. The info pane keeps them and marks them,
    // because there the question is "does this link still point somewhere"; here
    // the question is what is around this project now, and something archived
    // has been answered already.
    const rows = await db
      .select(blockView)
      .from(blocks)
      .where(and(eq(blocks.ownerId, userId), inArray(blocks.id, ids), notArchived));
    return { blocks: rows, truncated: graph.truncated };
  });

  /** Info + connections for a block (right-panel info pane). */
  app.get("/blocks/:id/info", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [b] = await db
      .select({
        id: blocks.id,
        blockTypeId: blocks.blockTypeId,
        collectionKind: blocks.collectionKind,
        properties: blocks.properties,
        content: blocks.content,
        createdAt: blocks.createdAt,
        updatedAt: blocks.updatedAt,
      })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!b) throw notFound("block");
    const props = b.properties as Record<string, unknown>;
    const labelOf = (p: unknown, c: string | null) =>
      oneLineLabel(p as Record<string, unknown>, c) || "Untitled";

    // A block's type icon (colored): collections carry their own icon in
    // properties; typed blocks use their type's icon; text blocks use "type".
    type IconInfo = { iconKey: string | null; iconColor: string | null };
    const typeIconOf = (
      row: { blockTypeId: string | null; collectionKind: string | null; properties: unknown },
      map: Map<string, { iconKey: string | null; iconColor: string | null; isText: boolean }>,
    ): IconInfo => {
      if (row.collectionKind) {
        const p = (row.properties ?? {}) as Record<string, unknown>;
        return {
          iconKey: (p.icon_key as string) ?? "folder",
          iconColor: (p.icon_color as string) ?? null,
        };
      }
      const t = row.blockTypeId ? map.get(row.blockTypeId) : undefined;
      if (!t) return { iconKey: "type", iconColor: null };
      return { iconKey: t.isText ? "type" : t.iconKey, iconColor: t.iconColor };
    };

    // Type name + schema (to find reference fields) + this block's own icon.
    let type = "Text";
    let schema: import("@hermes/shared").PropertySchema | null = null;
    let selfIcon: IconInfo = { iconKey: "type", iconColor: null };
    if (b.collectionKind) {
      type = `Collection · ${b.collectionKind}`;
      selfIcon = typeIconOf(b, new Map());
    } else if (b.blockTypeId) {
      const [t] = await db
        .select({
          name: blockTypes.name,
          isText: blockTypes.isText,
          schema: blockTypes.propertySchema,
          iconKey: blockTypes.iconKey,
          iconColor: blockTypes.iconColor,
        })
        .from(blockTypes)
        .where(eq(blockTypes.id, b.blockTypeId))
        .limit(1);
      if (t) {
        type = t.isText ? "Text" : t.name;
        schema = t.schema;
        selfIcon = t.isText ? { iconKey: "type", iconColor: null } : { iconKey: t.iconKey, iconColor: t.iconColor };
      }
    }

    // Collections this block belongs to.
    const inRows = await db
      .select({
        id: blocks.id,
        properties: blocks.properties,
        content: blocks.content,
        blockTypeId: blocks.blockTypeId,
        collectionKind: blocks.collectionKind,
      })
      .from(memberships)
      .innerJoin(blocks, eq(blocks.id, memberships.collectionId))
      .where(eq(memberships.blockId, id));

    // References out (reference-field values + markdown `block:<id>` links in
    // this block's content).
    const outIds: string[] = [];
    for (const f of schema?.fields ?? []) {
      if (f.type !== "reference") continue;
      const v = props[f.key];
      if (Array.isArray(v)) outIds.push(...v.map(String));
      else if (typeof v === "string" && v) outIds.push(v);
    }
    // One reader for prose references, shared with the graph panel. It scans the
    // body as well as the properties, which this site did for `block:` links and
    // not for `@Name` — so a daily note that mentioned somebody was connected on
    // the graph and not here.
    const inline = inlineMentions(props, b.content, id);
    outIds.push(...inline.ids);
    const atNames = new Set<string>(inline.names);
    if (atNames.size) {
      const named = await db
        .select({ id: blocks.id })
        .from(blocks)
        .where(
          and(
            eq(blocks.ownerId, userId),
            notArchived,
            sql`${blocks.id} <> ${id}`,
            sql`lower(${blocks.properties}->>'title') IN (${sql.join(
              [...atNames].map((n) => sql`${n}`),
              sql`, `,
            )})`,
          ),
        )
        .limit(20);
      outIds.push(...named.map((r) => r.id));
    }
    let linkRows: {
      id: string;
      properties: unknown;
      content: string | null;
      blockTypeId: string | null;
      collectionKind: string | null;
      archivedAt: Date | null;
    }[] = [];
    if (outIds.length) {
      // Archived targets are kept (and flagged) rather than dropped — a link that
      // silently vanishes when its target is archived is more confusing than one
      // shown marked "archived".
      linkRows = await db
        .select({
          id: blocks.id,
          properties: blocks.properties,
          content: blocks.content,
          blockTypeId: blocks.blockTypeId,
          collectionKind: blocks.collectionKind,
          archivedAt: blocks.archivedAt,
        })
        .from(blocks)
        .where(and(eq(blocks.ownerId, userId), inArray(blocks.id, [...new Set(outIds)])));
    }

    // References in (other blocks that reference this one via a property value
    // or a markdown `block:<id>` link in their content/text).
    const myTitle = typeof props.title === "string" ? props.title.trim() : "";
    const fromRows = await db
      .select({
        id: blocks.id,
        properties: blocks.properties,
        content: blocks.content,
        blockTypeId: blocks.blockTypeId,
        collectionKind: blocks.collectionKind,
        archivedAt: blocks.archivedAt,
      })
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.id} <> ${id}`,
          or(
            // Bare-id property references — but not a daily note's layout list
            // (adding a block as a Today section isn't a "link").
            and(
              sql`jsonb_path_exists(${blocks.properties}, '$.** ? (@ == $v)', jsonb_build_object('v', ${id}::text))`,
              sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
      sql`NOT jsonb_exists(${blocks.properties}, ${TEMPLATE_MARKER})`,
              // Canvas edge/region bookkeeping holds member ids — placement,
              // not a reference (edges surface via canvasConnections instead).
              sql`${blocks.collectionKind} IS DISTINCT FROM 'canvas'`,
            ),
            sql`${blocks.content} LIKE ${`%block:${id}%`}`,
            sql`${blocks.properties}::text LIKE ${`%block:${id}%`}`,
            // Raw `|<id>` mention in a title/text field.
            sql`${blocks.properties}::text LIKE ${`%|${id}%`}`,
            // Raw `@Name` mention of this block's title (underscores = spaces).
            ...(myTitle
              ? [sql`${blocks.properties}::text ILIKE ${`%@${myTitle.replace(/[%_]/g, "_").replace(/ /g, "_")}%`}`]
              : []),
          ),
        ),
      )
      .limit(50);

    // Canvas edges: user-drawn connections on any canvas containing this block.
    const canvasRows = await db
      .select({ id: blocks.id, properties: blocks.properties })
      .from(blocks)
      .where(and(eq(blocks.ownerId, userId), eq(blocks.collectionKind, "canvas")));
    interface CanvasEdge {
      from?: string;
      to?: string;
      label?: string;
      live?: boolean;
    }
    const touching: { canvasLabel: string; otherId: string; edgeLabel?: string }[] = [];
    for (const c of canvasRows) {
      const cp = c.properties as Record<string, unknown>;
      const edges = Array.isArray(cp.canvas_edges) ? (cp.canvas_edges as CanvasEdge[]) : [];
      for (const e of edges) {
        if (e.from !== id && e.to !== id) continue;
        // Ephemeral edges are canvas-only decoration, not system connections.
        if (e.live === false) continue;
        const other = e.from === id ? e.to : e.from;
        // Skip edges to ephemeral canvas notes (not real blocks).
        if (!other || other.startsWith("n:")) continue;
        touching.push({ canvasLabel: labelOf(cp, null), otherId: other, edgeLabel: e.label });
      }
    }
    let canvasOtherRows: typeof linkRows = [];
    if (touching.length) {
      canvasOtherRows = await db
        .select({
          id: blocks.id,
          properties: blocks.properties,
          content: blocks.content,
          blockTypeId: blocks.blockTypeId,
          collectionKind: blocks.collectionKind,
          archivedAt: blocks.archivedAt,
        })
        .from(blocks)
        .where(and(eq(blocks.ownerId, userId), inArray(blocks.id, [...new Set(touching.map((t) => t.otherId))])));
    }

    // Resolve type icons for every connected block in one query.
    const connTypeIds = [
      ...new Set(
        [...inRows, ...linkRows, ...fromRows, ...canvasOtherRows]
          .map((r) => r.blockTypeId)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const typeMap = new Map<string, { iconKey: string | null; iconColor: string | null; isText: boolean }>();
    if (connTypeIds.length) {
      const trows = await db
        .select({
          id: blockTypes.id,
          iconKey: blockTypes.iconKey,
          iconColor: blockTypes.iconColor,
          isText: blockTypes.isText,
        })
        .from(blockTypes)
        .where(inArray(blockTypes.id, connTypeIds));
      for (const t of trows) typeMap.set(t.id, { iconKey: t.iconKey, iconColor: t.iconColor, isText: t.isText });
    }
    const withIcon = (r: {
      id: string;
      properties: unknown;
      content: string | null;
      blockTypeId: string | null;
      collectionKind: string | null;
      archivedAt?: Date | null;
    }) => {
      const p = r.properties as Record<string, unknown>;
      const today = typeof p?.today_note === "string" ? (p.today_note as string) : undefined;
      return {
        id: r.id,
        label: labelOf(r.properties, r.content),
        today,
        ...(r.archivedAt ? { archived: true as const } : {}),
        ...typeIconOf(r, typeMap),
      };
    };

    const inCollections = inRows.map(withIcon);
    const linksTo = linkRows.map(withIcon);
    const linkedFrom = fromRows.map(withIcon);
    // Outbound links whose target no longer resolves (hard-deleted, or no longer
    // owned) — surfaced under the info box's "Deleted" tab so the dead reference
    // can be cleared. Inbound/collection/canvas partners can't dangle: those come
    // from queries over existing blocks (or FK-backed memberships).
    const resolvedOut = new Set(linkRows.map((r) => r.id));
    const deletedLinks = [...new Set(outIds)]
      .filter((t) => t !== id && !resolvedOut.has(t))
      .map((t) => ({ id: t }));
    const canvasById = new Map(canvasOtherRows.map((r) => [r.id, r]));
    const canvasConnections = touching.flatMap((t) => {
      const row = canvasById.get(t.otherId);
      return row
        ? [{ ...withIcon(row), edgeLabel: t.edgeLabel, canvasLabel: t.canvasLabel }]
        : [];
    });

    const tagRows = await db
      .select({ name: tags.name })
      .from(blockTags)
      .innerJoin(tags, eq(tags.id, blockTags.tagId))
      .where(eq(blockTags.blockId, id))
      .orderBy(tags.name);

    const [ac] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(attachments)
      .where(eq(attachments.blockId, id));

    return {
      id: b.id,
      title: labelOf(props, b.content),
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      type,
      iconKey: selfIcon.iconKey,
      iconColor: selfIcon.iconColor,
      attachments: ac?.n ?? 0,
      inCollections,
      linksTo,
      linkedFrom,
      canvasConnections,
      deletedLinks,
      tags: tagRows.map((t) => t.name),
    };
  });

  /** Clear a dead outbound link — the target block no longer exists. Removes it
   *  from this block's reference-field values and strips its inline mentions from
   *  every text field (the label is kept; only the link is discarded). No confirm:
   *  it only ever touches a reference to an already-gone block. */
  app.post("/blocks/:id/clear-link", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { target } = z.object({ target: z.string().uuid() }).parse(req.body);
    const [b] = await db
      .select({
        content: blocks.content,
        properties: blocks.properties,
        blockTypeId: blocks.blockTypeId,
        collectionKind: blocks.collectionKind,
      })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!b) throw notFound("block");

    // Reference-field values store bare ids — drop the target from those first.
    const type = b.collectionKind ? null : await resolveType(userId, b.blockTypeId ?? undefined);
    const props = { ...((b.properties ?? {}) as Record<string, unknown>) };
    for (const f of type?.propertySchema?.fields ?? []) {
      if (f.type !== "reference") continue;
      const v = props[f.key];
      if (Array.isArray(v)) props[f.key] = v.filter((x) => String(x) !== target);
      else if (typeof v === "string" && v === target) delete props[f.key];
    }
    // Then strip inline mentions (keeping the label) from all text + content.
    const nextProps = rewriteStrings(props, (s) => stripLinkFromText(s, target)) as Record<string, unknown>;
    const nextContent = b.content != null ? stripLinkFromText(b.content, target) : b.content;

    const base = {
      content: nextContent,
      properties: nextProps,
      version: sql`${blocks.version} + 1`,
      updatedAt: new Date(),
    };
    // Collections embed via their own path; recompute embed_source only for
    // typed/text blocks (a collection's isn't derivable from a text type).
    if (type) {
      const embedSource = computeEmbedSource(type, { content: nextContent, properties: nextProps });
      const hash = sha256(embedSource);
      await db
        .update(blocks)
        .set({
          ...base,
          embedSource,
          embedSourceHash: sql`CASE WHEN ${blocks.embedSourceHash} = ${hash} THEN ${blocks.embedSourceHash} ELSE NULL END`,
        })
        .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)));
    } else {
      await db.update(blocks).set(base).where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)));
    }
    return { ok: true };
  });

  // Update a block (content for text, properties for typed) with optimistic
  // concurrency (doc §11).
  app.patch("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        content: z.string().optional(),
        /**
         * The whole property bag. Every caller in this codebase reads the block
         * first and sends it all back, which is the only reason this has never
         * lost anything — the shape itself says "send me everything you want to
         * keep", and the first client that sends only what it changed would be
         * the last time the rest of that block existed. Kept because those
         * callers exist; `patch` is the one to reach for.
         */
        properties: z.record(z.unknown()).optional(),
        /** A partial write: set these, remove those, leave everything else. */
        patch: z
          .object({
            set: z.record(z.unknown()).optional(),
            unset: z.array(z.string()).optional(),
          })
          .optional(),
        version: z.number().int(),
      })
      .parse(req.body);

    const [current] = await db
      .select({
        content: blocks.content,
        properties: blocks.properties,
        blockTypeId: blocks.blockTypeId,
        seriesId: blocks.seriesId,
      })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!current) throw notFound("block");

    const type = await resolveType(userId, current.blockTypeId ?? undefined);
    const nextContent = type.isText ? body.content ?? current.content ?? "" : current.content;
    // Text blocks now carry fields too (their body is `content`; other fields
    // live in properties), so both kinds may update properties.
    // A patch names what it touches; a bare bag replaces everything. The stale
    // check is the version in the WHERE clause below, which is why applyPatch is
    // not also given one — two places refusing the same write would disagree
    // eventually.
    const incoming = body.patch
      ? applyPatch({ properties: (current.properties ?? {}) as Record<string, unknown> }, body.patch).properties
      : ((body.properties ?? current.properties ?? {}) as Record<string, unknown>);
    const nextProps = stampDoneAt(
      type.propertySchema,
      (current.properties ?? {}) as Record<string, unknown>,
      stripBlankDates(type.propertySchema, incoming),
    );
    const seriesId = await syncSeries(
      userId,
      id,
      current.seriesId ?? null,
      type.propertySchema,
      nextProps as Record<string, unknown>,
    );
    const embedSource = computeEmbedSource(type, { content: nextContent, properties: nextProps });
    const hash = sha256(embedSource);

    const [updated] = await db
      .update(blocks)
      .set({
        content: nextContent,
        properties: nextProps,
        embedSource,
        embedSourceHash: sql`CASE WHEN ${blocks.embedSourceHash} = ${hash} THEN ${blocks.embedSourceHash} ELSE NULL END`,
        version: sql`${blocks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId), eq(blocks.version, body.version)))
      .returning(blockView);

    if (!updated) throw conflict("version conflict — reload and retry");

    // Title rename → fix raw @mentions and link labels in referencing blocks.
    const oldTitle = ((current.properties ?? {}) as Record<string, unknown>).title;
    const newTitle = ((nextProps ?? {}) as Record<string, unknown>).title;
    if (
      typeof oldTitle === "string" &&
      typeof newTitle === "string" &&
      oldTitle.trim() &&
      newTitle.trim() &&
      oldTitle.trim() !== newTitle.trim()
    ) {
      await propagateTitleRename(userId, id, oldTitle, newTitle);
    }

    // Add tags for any #tag mentions (add-only): `(tag:)` links anywhere, and
    // raw `#tag` tokens in the title/plain-text fields (mention-input syntax).
    const rawKeys = new Set([
      "title",
      ...(type.propertySchema?.fields ?? []).filter((f) => f.type === "text").map((f) => f.key),
    ]);
    const props = (nextProps ?? {}) as Record<string, unknown>;
    const tagsChanged = await syncTextTags(
      userId,
      id,
      [
        nextContent ?? "",
        ...Object.values(props).filter((v): v is string => typeof v === "string"),
      ],
      [...rawKeys].map((k) => props[k]).filter((v): v is string => typeof v === "string"),
    );

    // Recurring task just completed → spawn the next occurrence.
    let recurred = false;
    // `body.patch` counts too. Guarding on `body.properties` alone meant a client
    // that completed a task the new way — the way this codebase now recommends —
    // silently got no next occurrence.
    if (!type.isText && (body.properties || body.patch)) {
      recurred = await spawnRecurrence(
        userId,
        { id: type.id, schemaVersion: type.schemaVersion, propertySchema: type.propertySchema },
        (current.properties ?? {}) as Record<string, unknown>,
        nextProps as Record<string, unknown>,
        { id, seriesId },
      );
    }
    return { ...updated, recurred, tagsChanged };
  });

  /**
   * Directed links AMONG a given set of blocks — backs the canvas "show existing
   * connections" overlay. Returns `{ from, to }` pairs where `from` links to
   * `to` and both ids are in the set: reference-field values, `block:<id>` /
   * `|<id>` markdown links, and `@Name` mentions resolved by title. User-drawn
   * canvas edges are deliberately NOT included (those are already visible).
   */
  app.post("/blocks/links", async (req) => {
    const userId = requireUser(req);
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(500) }).parse(req.body);
    if (ids.length < 2) return { pairs: [] };
    const rows = await db
      .select({ id: blocks.id, content: blocks.content, properties: blocks.properties })
      .from(blocks)
      .where(and(eq(blocks.ownerId, userId), notArchived, inArray(blocks.id, ids)));
    const memberIds = new Set(rows.map((r) => r.id));
    const titleToId = new Map<string, string>();
    for (const r of rows) {
      const title = (r.properties as Record<string, unknown>)?.title;
      const t = typeof title === "string" ? title.trim().toLowerCase() : "";
      if (t && !titleToId.has(t)) titleToId.set(t, r.id);
    }
    const linkRe = /block:([0-9a-fA-F-]{36})|\|([0-9a-fA-F-]{36})/g;
    const atRe = /(^|\s)@([A-Za-z0-9][\w-]*)/g;
    const pairs: { from: string; to: string }[] = [];
    const seen = new Set<string>();
    const add = (from: string, to: string) => {
      if (from === to || !memberIds.has(to)) return;
      const k = `${from}|${to}`;
      if (seen.has(k)) return;
      seen.add(k);
      pairs.push({ from, to });
    };
    for (const r of rows) {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const strings = [r.content ?? "", ...Object.values(props).map((v) => (typeof v === "string" ? v : ""))];
      for (const text of strings) {
        let m: RegExpExecArray | null;
        linkRe.lastIndex = 0;
        while ((m = linkRe.exec(text)) !== null) {
          const t = m[1] ?? m[2];
          if (t) add(r.id, t);
        }
        atRe.lastIndex = 0;
        let a: RegExpExecArray | null;
        while ((a = atRe.exec(text)) !== null) {
          if (!a[2]) continue;
          const id = titleToId.get(a[2].replace(/_/g, " ").toLowerCase());
          if (id) add(r.id, id);
        }
      }
      // Bare-id property values cover reference fields without needing schema.
      for (const v of Object.values(props)) {
        if (typeof v === "string" && memberIds.has(v)) add(r.id, v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && memberIds.has(x)) add(r.id, x);
      }
    }
    return { pairs };
  });

  // ── Tags ─────────────────────────────────────────────────────
  app.get("/tags", async (req) => {
    const userId = requireUser(req);
    return db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(eq(tags.ownerId, userId))
      .orderBy(tags.name);
  });

  /** Rename a tag everywhere: the tag row itself (merging into an existing
   * target), plus raw `#old` tokens and `(tag:old)` mention links in text. */
  app.post("/tags/rename", async (req) => {
    const userId = requireUser(req);
    const body = z
      .object({ from: z.string().trim().min(1), to: z.string().trim().min(1) })
      .parse(req.body);
    const from = body.from.toLowerCase().replace(/^#+/, "");
    const to = body.to.toLowerCase().replace(/^#+/, "");
    if (!from || !to || from === to) return { rewritten: 0 };

    const [src] = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.ownerId, userId), eq(tags.name, from)))
      .limit(1);
    if (!src) throw notFound("tag");
    const [dst] = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.ownerId, userId), eq(tags.name, to)))
      .limit(1);
    if (!dst) {
      await db.update(tags).set({ name: to }).where(eq(tags.id, src.id));
    } else {
      // Merge: repoint associations (skipping dupes), drop the old row.
      const rows = await db
        .select({ blockId: blockTags.blockId })
        .from(blockTags)
        .where(eq(blockTags.tagId, src.id));
      for (const r of rows)
        await db.insert(blockTags).values({ blockId: r.blockId, tagId: dst.id }).onConflictDoNothing();
      await db.delete(blockTags).where(eq(blockTags.tagId, src.id));
      await db.delete(tags).where(eq(tags.id, src.id));
    }

    // `#old` tokens (covers `[#old]` labels too) and `(tag:old)` link targets.
    const tokRe = new RegExp(`#${escapeRe(from)}(?![\\w-])`, "gi");
    const linkRe = new RegExp(`\\(tag:${escapeRe(from)}\\)`, "gi");
    const rewritten = await rewriteReferences(userId, null, [`#${from}`, `tag:${from}`], (s) =>
      s.replace(tokRe, `#${to}`).replace(linkRe, `(tag:${to})`),
    );
    return { rewritten };
  });

  /** Create a standalone tag (used by the "#" mention "create" option). */
  app.post("/tags", async (req) => {
    const userId = requireUser(req);
    const { name } = z.object({ name: z.string().trim().min(1) }).parse(req.body);
    const [row] = await db
      .insert(tags)
      .values({ ownerId: userId, name })
      .onConflictDoNothing()
      .returning({ id: tags.id, name: tags.name });
    if (row) return row;
    const [existing] = await db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(and(eq(tags.ownerId, userId), eq(tags.name, name)))
      .limit(1);
    return existing;
  });

  app.get("/blocks/:id/tags", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await db
      .select({ name: tags.name })
      .from(blockTags)
      .innerJoin(tags, eq(tags.id, blockTags.tagId))
      .where(and(eq(blockTags.blockId, id), eq(tags.ownerId, userId)))
      .orderBy(tags.name);
    return rows.map((r) => r.name);
  });

  app.put("/blocks/:id/tags", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { tags: names } = z.object({ tags: z.array(z.string()) }).parse(req.body);
    const [b] = await db
      .select({ id: blocks.id })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!b) throw notFound("block");

    const clean = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
    await db.transaction(async (tx) => {
      await tx.delete(blockTags).where(eq(blockTags.blockId, id));
      for (const name of clean) {
        await tx.insert(tags).values({ ownerId: userId, name }).onConflictDoNothing();
        const [tag] = await tx
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.ownerId, userId), eq(tags.name, name)))
          .limit(1);
        if (tag) await tx.insert(blockTags).values({ blockId: id, tagId: tag.id }).onConflictDoNothing();
      }
    });
    return { tags: clean };
  });

  /** Archive a block: hide it from every normal view (still openable by id, and
   * reversible). Collections are never archivable. */
  app.post("/blocks/:id/archive", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [block] = await db
      .select({
        collectionKind: blocks.collectionKind,
        blockTypeId: blocks.blockTypeId,
        properties: blocks.properties,
      })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!block) throw notFound("block");
    // The "Do weekly review" task can't be filed away half-finished — it stays
    // archivable only once it's complete. Use isComplete (any complete value) so
    // a review closed as "wont_do" is archivable, and so this agrees with the
    // auto-archive / "archive now" sweeps (which archive on isComplete too).
    const props = (block.properties ?? {}) as Record<string, unknown>;
    // A periodic note belongs to its span of time, not to a list you file away:
    // the page that owns it resolves it by marker and would keep rendering an
    // archived one, and an empty one is swept automatically anyway. The UI hides
    // the action; enforce it here so it holds for direct callers too.
    const periodic = periodicKindOf(props);
    if (periodic) throw badRequest(`a ${periodic.kind.label} belongs to its period and can't be archived`);
    if (props.weekly_review === true && block.blockTypeId) {
      const [type] = await db
        .select({ propertySchema: blockTypes.propertySchema })
        .from(blockTypes)
        .where(and(eq(blockTypes.id, block.blockTypeId), eq(blockTypes.ownerId, userId)))
        .limit(1);
      if (!type?.propertySchema || !isComplete(type.propertySchema, props))
        throw badRequest("Finish the weekly review before archiving it.");
    }
    await db
      .update(blocks)
      .set({ archivedAt: new Date(), version: sql`${blocks.version} + 1` })
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)));
    return { ok: true };
  });

  /** Restore an archived block — it reappears everywhere it was (memberships and
   * positions were never touched). */
  app.post("/blocks/:id/unarchive", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [gone] = await db
      .update(blocks)
      .set({ archivedAt: null, version: sql`${blocks.version} + 1` })
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .returning({ id: blocks.id });
    if (!gone) throw notFound("block");
    return { ok: true };
  });

  /** Permanent delete. Only an already-archived block may be hard-deleted, so
   * the sole path to real deletion is via the Archive screen — enforced here at
   * the route, not just in the UI/MCP, so it holds for direct API callers too. */
  /**
   * Empty the Archive: every archived block AND collection, permanently.
   *
   * One request rather than one per row — a client loop over hundreds of
   * deletes is slow, and a failure halfway through leaves the user staring at a
   * half-emptied Archive with no way to tell what went. Same browser-session
   * rule as a single delete: an agent can archive, never destroy.
   */
  app.post("/archive/empty", async (req) => {
    const userId = requireUser(req);
    if (req.authKind !== "cookie") throw forbidden("hard delete requires a browser session");
    const doomed = await db
      .select({ id: blocks.id })
      .from(blocks)
      .where(and(eq(blocks.ownerId, userId), sql`${blocks.archivedAt} IS NOT NULL`));
    if (!doomed.length) return { deleted: 0 };
    await db
      .delete(blocks)
      .where(and(eq(blocks.ownerId, userId), sql`${blocks.archivedAt} IS NOT NULL`));
    // FK-backed relations cascade; references stored in JSON don't.
    for (const b of doomed) await scrubDanglingRefs(userId, b.id);
    return { deleted: doomed.length };
  });

  app.delete("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    // Irreversible deletion is a browser-session-only action: an API/bearer key
    // (i.e. an AI agent, which can be prompt-injected) can archive but never
    // hard-delete. Humans delete from the Archive screen over a cookie session.
    if (req.authKind !== "cookie") throw forbidden("hard delete requires a browser session");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [block] = await db
      .select({ archivedAt: blocks.archivedAt })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!block) throw notFound("block");
    if (!block.archivedAt) throw badRequest("archive the block before deleting it");
    await db.delete(blocks).where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)));
    // FK-backed relations cascade; JSON-stored references don't — scrub those.
    await scrubDanglingRefs(userId, id);
    return { ok: true };
  });
}
