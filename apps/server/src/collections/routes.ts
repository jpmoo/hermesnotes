import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import {
  collectionKindSchema,
  filterQuerySchema,
  listFormatSchema,
  membershipModeSchema,
  normalizeFilter,
  smartModeSchema,
} from "@hermes/shared";
import { blocks, blockTypes, memberships } from "@hermes/db";
import { db } from "../db.js";
import { sha256 } from "../lib/hash.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { computeEmbedSource } from "../blocks/embed-source.js";
import { runQuery, runQueryCounted } from "./query.js";

const ICON_BY_KIND: Record<string, string> = {
  document: "file-text",
  list: "list",
  table: "table",
  kanban: "kanban",
  matrix: "grid-3x3",
  masonry: "layout-grid",
  canvas: "workflow",
  calendar: "calendar-days",
  rollup: "scroll",
};

/** Embed a collection by its own title + description (design doc §4). */
function collectionEmbedSource(properties: Record<string, unknown>): string {
  return [properties.title, properties.description]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join("\n");
}

const collectionView = {
  id: blocks.id,
  collectionKind: blocks.collectionKind,
  properties: blocks.properties,
  createdAt: blocks.createdAt,
  updatedAt: blocks.updatedAt,
  version: blocks.version,
};

function labelOf(b: { properties: Record<string, unknown>; content: string | null }): string {
  const title = b.properties?.title;
  return (
    (typeof title === "string" && title.trim()) ||
    (b.content ?? "").replace(/\s+/g, " ").trim().slice(0, 80) ||
    "Untitled"
  );
}

function safeFilter(value: unknown): import("@hermes/shared").FilterQuery {
  return normalizeFilter(value);
}

/** Replace a snapshot collection's memberships with the query's current matches. */
async function materialize(
  userId: string,
  collectionId: string,
  filter: import("@hermes/shared").FilterQuery,
): Promise<void> {
  const matches = await runQuery(userId, filter);
  await db.transaction(async (tx) => {
    await tx.delete(memberships).where(eq(memberships.collectionId, collectionId));
    let prev: string | null = null;
    for (const m of matches) {
      prev = generateKeyBetween(prev, null);
      await tx
        .insert(memberships)
        .values({ collectionId, blockId: m.id, position: prev })
        .onConflictDoNothing();
    }
  });
}

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // Top-level collections (not nested inside another collection).
  app.get("/collections", async (req) => {
    const userId = requireUser(req);
    // Every collection, including ones nested inside a document — they're still
    // real collections and must be resolvable (e.g. a matrix embedded in a
    // dashboard, searched by MCP `list`/`region`).
    return db
      .select(collectionView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NOT NULL`,
          // Archived collections are out of sight everywhere but the Archive,
          // exactly like archived blocks.
          sql`${blocks.archivedAt} IS NULL`,
        ),
      )
      .orderBy(sql`${blocks.updatedAt} DESC`);
  });

  /** Archived collections, for the Archive screen. */
  app.get("/collections/archived", async (req) => {
    const userId = requireUser(req);
    return db
      .select(collectionView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NOT NULL`,
          sql`${blocks.archivedAt} IS NOT NULL`,
        ),
      )
      .orderBy(sql`${blocks.updatedAt} DESC`);
  });

  app.post("/collections", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        /**
         * Chosen by the caller, the way `POST /blocks` already allows.
         *
         * What it buys is retry: a client that never heard the answer can send
         * the same request again and have the second one recognised as the
         * first. Without it the interchange binding's create could not promise
         * that, and a dropped response would leave a second board behind every
         * time a client restarted mid-call.
         */
        id: z.string().uuid().optional(),
        kind: collectionKindSchema,
        title: z.string().default("Untitled"),
        description: z.string().optional(),
        membershipMode: membershipModeSchema.default("explicit"),
        smartMode: smartModeSchema.default("dynamic"),
        filterQuery: filterQuerySchema.optional(),
        listFormat: listFormatSchema.optional(),
        matrixCols: z.number().int().min(1).max(6).optional(),
        matrixRows: z.number().int().min(1).max(6).optional(),
      })
      .parse(req.body);

    const properties: Record<string, unknown> = {
      title: body.title,
      description: body.description ?? "",
      membership_mode: body.membershipMode,
      icon_key: ICON_BY_KIND[body.kind] ?? "folder",
      icon_color: "#5fa4b5",
    };
    if (body.membershipMode === "smart") {
      properties.smart_mode = body.smartMode;
      properties.filter_query = safeFilter(body.filterQuery);
    }
    if (body.kind === "list") {
      properties.list_format = body.listFormat ?? "bullet";
      properties.sort_mode = "manual";
      properties.sync_checkbox_with_status = true;
    }
    if (body.kind === "table") {
      // Column keys ("prop:<key>", "tags", "created", "edited"), view toggles,
      // sort levels, and per-column widths all live in properties; the client
      // patches them as the user shapes the table.
      properties.table_columns = [];
      properties.table_row_numbers = true;
      properties.table_wrap = false;
      properties.table_header_color = null;
      properties.table_sort = [];
      properties.table_col_widths = {};
    }
    if (body.kind === "canvas") {
      // A canvas is always explicit membership; blocks arrive by manual drop
      // or by the on-canvas query's Apply (a one-shot placement, not a feed).
      properties.membership_mode = "explicit";
      properties.canvas_edges = [];
      properties.canvas_notes = [];
    }
    if (body.kind === "calendar") {
      // Smart-fed date view (month/week/3-day). Cards auto-place by their
      // date/datespan fields; no explicit placement. Default to month.
      properties.calendar_view = "month";
    }
    if (body.kind === "matrix") {
      // An x/y grid of regions; members are placed via context.region (index,
      // row-major). A smart matrix uses its query only to feed the drawer.
      const cols = body.matrixCols ?? 2;
      const rows = body.matrixRows ?? 2;
      properties.matrix_cols = cols;
      properties.matrix_rows = rows;
      properties.matrix_regions = Array.from({ length: cols * rows }, () => ({
        title: "",
        color: null,
      }));
    }

    const [row] = await db
      .insert(blocks)
      .values({
        ...(body.id ? { id: body.id } : {}),
        ownerId: userId,
        blockTypeId: null,
        collectionKind: body.kind,
        properties,
        embedSource: collectionEmbedSource(properties),
        embedSourceHash: null,
      })
      .returning(collectionView);

    // Snapshot: materialize current matches into memberships once. Matrices
    // never auto-materialize — placement is always an explicit drag.
    if (
      body.membershipMode === "smart" &&
      body.smartMode === "snapshot" &&
      body.kind !== "matrix" &&
      body.kind !== "canvas" &&
      row
    ) {
      await materialize(userId, row.id, safeFilter(body.filterQuery));
    }
    reply.code(201);
    return row;
  });

  // Collection + its ordered members.
  app.get("/collections/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // A Today page passes its own date, so a smart collection embedded there
    // reads as of that day rather than the real one.
    const { as_of: asOf } = z
      .object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(req.query ?? {});
    const [collection] = await db
      .select(collectionView)
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!collection || !collection.collectionKind) throw notFound("collection");

    const props = collection.properties as Record<string, unknown>;
    // Smart + dynamic: membership is the live query result (synthesized
    // members). Matrices are exempt — their placements are always explicit
    // memberships; the query only feeds the drawer.
    if (
      props.membership_mode === "smart" &&
      props.smart_mode === "dynamic" &&
      collection.collectionKind !== "matrix"
    ) {
      const matched = await runQuery(userId, safeFilter(props.filter_query), false, asOf);
      const members = matched.map((b, i) => ({
        membershipId: `q:${b.id}`,
        position: String(i).padStart(6, "0"),
        context: {} as Record<string, unknown>,
        membershipVersion: 1,
        id: b.id,
        blockTypeId: b.blockTypeId,
        collectionKind: null as string | null,
        content: b.content,
        properties: b.properties,
        version: b.version,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      }));
      return { collection, members };
    }

    const members = await db
      .select({
        membershipId: memberships.id,
        position: memberships.position,
        context: memberships.context,
        membershipVersion: memberships.version,
        id: blocks.id,
        blockTypeId: blocks.blockTypeId,
        collectionKind: blocks.collectionKind,
        content: blocks.content,
        properties: blocks.properties,
        version: blocks.version,
        createdAt: blocks.createdAt,
        updatedAt: blocks.updatedAt,
      })
      .from(memberships)
      .innerJoin(blocks, eq(blocks.id, memberships.blockId))
      // Archived members stay in the collection (membership untouched) but are
      // hidden until unarchived.
      .where(and(eq(memberships.collectionId, id), sql`${blocks.archivedAt} IS NULL`))
      .orderBy(asc(memberships.position));

    return { collection, members };
  });

  // Live preview of a query (for the builder) — count + a sample of matches.
  app.post("/collections/query-preview", async (req) => {
    const userId = requireUser(req);
    // `archived` matters: a preview that always counts live blocks reports a
    // number the caller's own list will never show. The Archive asks for the
    // archived side.
    const { filterQuery, archived } = z
      .object({ filterQuery: filterQuerySchema, archived: z.boolean().optional() })
      .parse(req.body);
    const { rows: matches, total } = await runQueryCounted(userId, filterQuery, archived ?? false);
    return {
      count: total,
      blocks: matches.slice(0, 50).map((b) => ({
        id: b.id,
        blockTypeId: b.blockTypeId,
        label: labelOf(b),
      })),
    };
  });

  // Re-run a snapshot collection's query into its membership list.
  app.post("/collections/:id/materialize", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [c] = await db
      .select({ properties: blocks.properties })
      .from(blocks)
      .where(
        and(eq(blocks.id, id), eq(blocks.ownerId, userId), sql`${blocks.collectionKind} IS NOT NULL`),
      )
      .limit(1);
    if (!c) throw notFound("collection");
    await materialize(userId, id, safeFilter((c.properties as Record<string, unknown>).filter_query));
    return { ok: true };
  });

  app.patch("/collections/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    /**
     * Two shapes, one route.
     *
     * The app sends a bare bag of properties to merge, which is what this has
     * always taken. A partial write — `{ patch: { set, unset }, version }` —
     * names what it touches and is the only way to *remove* a key, which a
     * merge can never express. Same division as `PATCH /blocks/:id`, whose
     * shape this deliberately copies rather than inventing a third spelling.
     */
    const body = req.body as Record<string, unknown>;
    const partial =
      body && typeof body === "object" && "patch" in body
        ? z
            .object({
              patch: z.object({
                set: z.record(z.unknown()).optional(),
                unset: z.array(z.string()).optional(),
              }),
              version: z.number().int().optional(),
            })
            .parse(body)
        : null;
    const patch = partial ? {} : z.record(z.unknown()).parse(req.body);

    const [current] = await db
      .select({
        properties: blocks.properties,
        collectionKind: blocks.collectionKind,
        version: blocks.version,
      })
      .from(blocks)
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .limit(1);
    if (!current || !current.collectionKind) throw notFound("collection");
    // Refused, not merged. Merging a stale write is how one client's edit
    // silently reverts another's with the writer told it landed.
    if (partial?.version !== undefined && partial.version !== current.version) {
      throw conflict("collection has changed since you read it");
    }

    const nextProps = partial
      ? (() => {
          const out = { ...(current.properties as Record<string, unknown>), ...(partial.patch.set ?? {}) };
          for (const k of partial.patch.unset ?? []) delete out[k];
          return out;
        })()
      : { ...current.properties, ...patch };
    const embedSource = collectionEmbedSource(nextProps);
    const hash = sha256(embedSource);
    const [row] = await db
      .update(blocks)
      .set({
        properties: nextProps,
        embedSource,
        embedSourceHash: sql`CASE WHEN ${blocks.embedSourceHash} = ${hash} THEN ${blocks.embedSourceHash} ELSE NULL END`,
        version: sql`${blocks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(blocks.id, id), eq(blocks.ownerId, userId)))
      .returning(collectionView);

    // Editing a snapshot collection's query re-materializes it immediately, so
    // the caller never has to hit "refresh" after saving.
    if (
      "filter_query" in (partial?.patch.set ?? patch) &&
      nextProps.membership_mode === "smart" &&
      nextProps.smart_mode === "snapshot"
    ) {
      await materialize(userId, id, safeFilter(nextProps.filter_query));
    }
    return row;
  });

  /**
   * Permanent delete. Only an archived collection may be deleted, so the only
   * route to real deletion is via the Archive screen — the same rule blocks
   * follow, enforced here rather than in the UI so it holds for direct callers.
   */
  app.delete("/collections/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Irreversible deletion is a browser-session-only action: an access key (so,
    // an AI agent, which can be prompt-injected) can archive but never destroy.
    if (req.authKind !== "cookie") throw forbidden("hard delete requires a browser session");
    const [existing] = await db
      .select({ archivedAt: blocks.archivedAt })
      .from(blocks)
      .where(
        and(
          eq(blocks.id, id),
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NOT NULL`,
        ),
      )
      .limit(1);
    if (!existing) throw notFound("collection");
    if (!existing.archivedAt) throw badRequest("archive the collection before deleting it");
    // Memberships cascade; members with no other parent become unattached.
    const res = await db
      .delete(blocks)
      .where(
        and(eq(blocks.id, id), eq(blocks.ownerId, userId), sql`${blocks.collectionKind} IS NOT NULL`),
      )
      .returning({ id: blocks.id });
    if (!res.length) throw notFound("collection");
    return { ok: true };
  });

  // ── Members ──────────────────────────────────────────────────
  async function lastPosition(collectionId: string): Promise<string | null> {
    const [row] = await db
      .select({ position: memberships.position })
      .from(memberships)
      .where(eq(memberships.collectionId, collectionId))
      .orderBy(sql`${memberships.position} DESC`)
      .limit(1);
    return row?.position ?? null;
  }

  async function assertCollection(userId: string, id: string) {
    const [c] = await db
      .select({ id: blocks.id })
      .from(blocks)
      .where(
        and(eq(blocks.id, id), eq(blocks.ownerId, userId), sql`${blocks.collectionKind} IS NOT NULL`),
      )
      .limit(1);
    if (!c) throw notFound("collection");
  }

  // Add a member: either an existing block, or create a new one in place.
  app.post("/collections/:id/members", async (req, reply) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await assertCollection(userId, id);
    const body = z
      .object({
        blockId: z.string().uuid().optional(),
        context: z.record(z.unknown()).optional(),
        create: z
          .object({
            blockTypeId: z.string().uuid().optional(),
            content: z.string().optional(),
            properties: z.record(z.unknown()).optional(),
          })
          .optional(),
      })
      .parse(req.body);

    let blockId = body.blockId;
    if (!blockId) {
      // Create a new block (defaults to the text type — found by the isText
      // flag, not the user-renameable name).
      const c = body.create ?? {};
      const where = c.blockTypeId
        ? and(eq(blockTypes.id, c.blockTypeId), eq(blockTypes.ownerId, userId))
        : and(eq(blockTypes.ownerId, userId), eq(blockTypes.isText, true));
      const [type] = await db.select().from(blockTypes).where(where).limit(1);
      if (!type) throw badRequest("unknown block type");
      const defaults: Record<string, unknown> = {};
      const schema = type.propertySchema;
      if (!type.isText && schema?.status_field && schema.default_value != null) {
        defaults[schema.status_field] = schema.default_value;
      }
      const content = type.isText ? c.content ?? "" : null;
      const properties = type.isText ? {} : { ...defaults, ...(c.properties ?? {}) };
      const embedSource = computeEmbedSource(type, { content, properties });
      const [b] = await db
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
        .returning({ id: blocks.id });
      blockId = b!.id;
    } else {
      const [b] = await db
        .select({ id: blocks.id })
        .from(blocks)
        .where(and(eq(blocks.id, blockId), eq(blocks.ownerId, userId)))
        .limit(1);
      if (!b) throw badRequest("unknown block");
    }

    const position = generateKeyBetween(await lastPosition(id), null);
    const [membership] = await db
      .insert(memberships)
      .values({ collectionId: id, blockId, position, context: body.context ?? {} })
      .onConflictDoNothing()
      .returning({ id: memberships.id });
    if (!membership) throw conflict("block is already in this collection");
    reply.code(201);
    return { membershipId: membership.id, blockId, position };
  });

  app.delete("/collections/:id/members/:blockId", async (req) => {
    const userId = requireUser(req);
    const { id, blockId } = z
      .object({ id: z.string().uuid(), blockId: z.string().uuid() })
      .parse(req.params);
    await assertCollection(userId, id);
    await db
      .delete(memberships)
      .where(and(eq(memberships.collectionId, id), eq(memberships.blockId, blockId)));
    return { ok: true };
  });

  // Reorder (afterId/beforeId neighbors) and/or update membership context.
  app.patch("/collections/:id/members/:blockId", async (req) => {
    const userId = requireUser(req);
    const { id, blockId } = z
      .object({ id: z.string().uuid(), blockId: z.string().uuid() })
      .parse(req.params);
    await assertCollection(userId, id);
    const body = z
      .object({
        afterId: z.string().uuid().nullable().optional(),
        beforeId: z.string().uuid().nullable().optional(),
        context: z.record(z.unknown()).optional(),
        /**
         * Keys to take out of the context bag.
         *
         * `context` merges, which is right — a caller that moved a card sends
         * the coordinates it moved and must not delete the size and colour
         * another tool put there. That leaves no way to remove one, so removal
         * is said out loud, and the read-modify-write lives here rather than in
         * every caller that wants to clear a flag.
         */
        unsetContext: z.array(z.string()).optional(),
        /**
         * The version the caller believes it is changing.
         *
         * Optional: a caller that has not read the membership is writing
         * blind and is entitled to, the same as before this existed. When it
         * *is* sent, it is compared as part of the UPDATE rather than before
         * it — see below, where the guard is a WHERE clause and not an `if`.
         */
        expectVersion: z.number().int().optional(),
      })
      .parse(req.body);

    const set: Record<string, unknown> = {};

    if (body.afterId !== undefined || body.beforeId !== undefined) {
      const posOf = async (bid: string | null | undefined): Promise<string | null> => {
        if (!bid) return null;
        const [m] = await db
          .select({ position: memberships.position })
          .from(memberships)
          .where(and(eq(memberships.collectionId, id), eq(memberships.blockId, bid)))
          .limit(1);
        return m?.position ?? null;
      };
      const after = await posOf(body.afterId);
      const before = await posOf(body.beforeId);
      set.position = generateKeyBetween(after, before);
    }

    if (body.context || body.unsetContext?.length) {
      const [m] = await db
        .select({ context: memberships.context })
        .from(memberships)
        .where(and(eq(memberships.collectionId, id), eq(memberships.blockId, blockId)))
        .limit(1);
      const next = { ...(m?.context ?? {}), ...(body.context ?? {}) };
      for (const k of body.unsetContext ?? []) delete next[k];
      set.context = next;
    }

    if (Object.keys(set).length === 0) return { ok: true };
    set.version = sql`${memberships.version} + 1`;
    /**
     * The comparison is part of the write.
     *
     * Not `read the version, check it, then update` — those are two statements
     * with a gap between them, and the gap is exactly where the other writer
     * goes. Two clients both read 7, both find it current, and both write, and
     * the version that was added to prevent that has instead documented it.
     *
     * As a WHERE clause the database does the comparing, and a stale caller
     * updates no rows. Which is then indistinguishable from a membership that
     * is not there at all — so that is asked separately, and only when zero
     * rows came back, where it costs nothing on the path that worked.
     */
    const touched = await db
      .update(memberships)
      .set(set)
      .where(
        and(
          eq(memberships.collectionId, id),
          eq(memberships.blockId, blockId),
          ...(body.expectVersion === undefined ? [] : [eq(memberships.version, body.expectVersion)]),
        ),
      )
      .returning({ id: memberships.id, version: memberships.version });
    // A write that changed nothing must not answer as though it did.
    //
    // Patching a membership that does not exist updates no rows, and this used
    // to return `{ ok: true }` for it. That is the worst possible answer: a card
    // dragged out of a smart matrix's drawer has no membership row, so the move
    // reported success and the card stayed exactly where it was, with nothing
    // anywhere to say why. Silence is what made it take months to find.
    if (touched.length === 0) {
      // Which of the two it was. A caller told "not found" for a card that is
      // on the board and was merely moved underneath it would go looking for a
      // membership bug, and a caller told "conflict" for a card that is not
      // there would retry forever.
      if (body.expectVersion !== undefined) {
        const [row] = await db
          .select({ version: memberships.version })
          .from(memberships)
          .where(and(eq(memberships.collectionId, id), eq(memberships.blockId, blockId)))
          .limit(1);
        if (row) throw conflict(`membership is at version ${row.version}`);
      }
      throw notFound("membership");
    }
    return { ok: true, version: touched[0]?.version };
  });
}
