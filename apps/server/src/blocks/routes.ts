import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  filterQuerySchema,
  isComplete,
  nextSpan,
  normalizeFilter,
  oneLineLabel,
  recurrenceContinues,
  recurrenceSchema,
  type PropertySchema,
} from "@hermes/shared";
import { attachments, blocks, blockTags, blockTypes, memberships, tags, userSettings } from "@hermes/db";
import { db } from "../db.js";
import { runQuery, semanticIds } from "../collections/query.js";
import { sha256 } from "../lib/hash.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { computeEmbedSource } from "./embed-source.js";

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
): Promise<boolean> {
  const schema = type.propertySchema;
  if (!schema?.status_field) return false;
  if (!(isComplete(schema, nextProps) && !isComplete(schema, prevProps))) return false;

  const recField = schema.fields.find((f) => f.type === "recurrence");
  const spanField = schema.fields.find((f) => f.type === "datespan");
  if (!recField || !spanField) return false;

  const parsed = recurrenceSchema.safeParse(nextProps[recField.key]);
  if (!parsed.success) return false;
  const rec = parsed.data;

  const span = (nextProps[spanField.key] ?? {}) as { start?: string; end?: string };
  const now = new Date();
  const completedOn = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const next = nextSpan(span, rec, completedOn);
  if (!next?.end) return false;

  const currentN = rec.n ?? 1;
  if (!recurrenceContinues(rec, currentN, next.end)) return false;

  const copyProps: Record<string, unknown> = {
    ...nextProps,
    [schema.status_field]: schema.default_value ?? null,
    [spanField.key]: next,
    [recField.key]: { ...rec, n: currentN + 1 },
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
  createdAt: blocks.createdAt,
  updatedAt: blocks.updatedAt,
};

export async function blockRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Create a block of any type. Text types embed content; typed blocks derive
  // embed_source from their properties. Left stale for the embedding worker.
  app.post("/blocks", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
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
    const embedSource = computeEmbedSource(type, { content, properties });

    const [row] = await db
      .insert(blocks)
      .values({
        ownerId: userId,
        blockTypeId: type.id,
        content,
        properties,
        embedSource,
        embedSourceHash: null,
        blockTypeSchemaVersion: type.schemaVersion,
      })
      .returning(blockView);
    reply.code(201);
    return row;
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
    const { filterQuery } = z
      .object({ filterQuery: filterQuerySchema.optional() })
      .parse(req.body ?? {});
    const matched = await runQuery(userId, normalizeFilter(filterQuery));
    return matched.map((b) => ({
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
  });

  /**
   * Blocks of a given type (for the Types page), newest-edited first. An
   * optional `q` matches title / description / body content, plus semantic
   * similarity above the account's default threshold (no per-query slider here).
   */
  app.get("/blocks/of-type/:typeId", async (req) => {
    const userId = requireUser(req);
    const { typeId } = z.object({ typeId: z.string().uuid() }).parse(req.params);
    const { q } = z.object({ q: z.string().optional() }).parse(req.query);

    const filters = [
      eq(blocks.ownerId, userId),
      eq(blocks.blockTypeId, typeId),
      sql`${blocks.collectionKind} IS NULL`,
      sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
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
      .object({ typeId: z.string().uuid(), q: z.string().optional() })
      .parse(req.query);
    const filters = [
      eq(blocks.ownerId, userId),
      eq(blocks.blockTypeId, typeId),
      sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
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
    const { q } = z.object({ q: z.string() }).parse(req.query);
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
          sql`(${blocks.properties}::text ILIKE ${like} OR ${blocks.content} ILIKE ${like})`,
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
        .where(and(eq(blocks.ownerId, userId), inArray(blocks.id, fresh)))
        .orderBy(desc(blocks.updatedAt))
        .limit(10);
      semantic = srows.map((r) => toHit(r, true));
    }
    return [...literal, ...semantic];
  });

  app.get("/blocks/search", async (req) => {
    const userId = requireUser(req);
    const { q, typeId, excludeCollectionId } = z
      .object({
        q: z.string().optional(),
        typeId: z.string().uuid().optional(),
        excludeCollectionId: z.string().uuid().optional(),
      })
      .parse(req.query);

    const filters = [
      eq(blocks.ownerId, userId),
      sql`${blocks.collectionKind} IS NULL`,
      sql`NOT jsonb_exists(${blocks.properties}, 'today_note')`,
    ];
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
      label: oneLineLabel(r.properties as Record<string, unknown>, r.content) || "Untitled",
    }));
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
    const linkRe = /block:([0-9a-fA-F-]{36})|\|([0-9a-fA-F-]{36})/g;
    for (const text of [b.content ?? "", ...Object.values(props).map((v) => (typeof v === "string" ? v : ""))]) {
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(text)) !== null) {
        const target = m[1] ?? m[2];
        if (target && target !== id) outIds.push(target);
      }
    }
    // Raw `@Name_With_Underscores` mentions resolve by exact title match.
    const atNames = new Set<string>();
    for (const text of Object.values(props).map((v) => (typeof v === "string" ? v : ""))) {
      const re = /(^|\s)@([A-Za-z0-9][\w-]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) if (m[2]) atNames.add(m[2].replace(/_/g, " ").toLowerCase());
    }
    if (atNames.size) {
      const named = await db
        .select({ id: blocks.id })
        .from(blocks)
        .where(
          and(
            eq(blocks.ownerId, userId),
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
    }[] = [];
    if (outIds.length) {
      linkRows = await db
        .select({
          id: blocks.id,
          properties: blocks.properties,
          content: blocks.content,
          blockTypeId: blocks.blockTypeId,
          collectionKind: blocks.collectionKind,
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

    // Resolve type icons for every connected block in one query.
    const connTypeIds = [
      ...new Set(
        [...inRows, ...linkRows, ...fromRows]
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
    }) => {
      const p = r.properties as Record<string, unknown>;
      const today = typeof p?.today_note === "string" ? (p.today_note as string) : undefined;
      return {
        id: r.id,
        label: labelOf(r.properties, r.content),
        today,
        ...typeIconOf(r, typeMap),
      };
    };

    const inCollections = inRows.map(withIcon);
    const linksTo = linkRows.map(withIcon);
    const linkedFrom = fromRows.map(withIcon);

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
      tags: tagRows.map((t) => t.name),
    };
  });

  // Update a block (content for text, properties for typed) with optimistic
  // concurrency (doc §11).
  app.patch("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        content: z.string().optional(),
        properties: z.record(z.unknown()).optional(),
        version: z.number().int(),
      })
      .parse(req.body);

    const [current] = await db
      .select({
        content: blocks.content,
        properties: blocks.properties,
        blockTypeId: blocks.blockTypeId,
      })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!current) throw notFound("block");

    const type = await resolveType(userId, current.blockTypeId ?? undefined);
    const nextContent = type.isText ? body.content ?? current.content ?? "" : current.content;
    // Text blocks now carry fields too (their body is `content`; other fields
    // live in properties), so both kinds may update properties.
    const nextProps = body.properties ?? current.properties;
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
    if (!type.isText && body.properties) {
      recurred = await spawnRecurrence(
        userId,
        { id: type.id, schemaVersion: type.schemaVersion, propertySchema: type.propertySchema },
        (current.properties ?? {}) as Record<string, unknown>,
        nextProps as Record<string, unknown>,
      );
    }
    return { ...updated, recurred, tagsChanged };
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

  app.delete("/blocks/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const res = await db
      .delete(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .returning({ id: blocks.id });
    if (!res.length) throw notFound("block");
    return { ok: true };
  });
}
