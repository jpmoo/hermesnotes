import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addToDefaults,
  carryForward,
  composeTodayLayout,
  placeCarried,
  customTodaySectionSchema,
  normalizeDefaultLayout,
  normalizeTodayLayout,
  PERIODIC_MARKERS,
  rangeCovers,
  removeFromDefaults,
  sectionKey,
  STANDARD_TODAY_SECTIONS,
  todayLayoutSchema,
  todayScopeSchema,
  type CustomTodaySection,
  type DefaultTodayLayout,
  type PropertySchema,
  type StandardTodaySection,
  type TodayLayout,
} from "@hermes/shared";
import { blocks, blockTypes, userSettings } from "@hermes/db";
import { db } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { zonedDayRange } from "../lib/timezone.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { purgeEmptyAutoNotes } from "../blocks/auto-notes.js";

/** The behind-the-scenes label for a date's scratchpad note, e.g. "Monday, July
 * 27, 2026 - Scratchpad". Shown wherever the block surfaces as a label (search,
 * cards, canvas/collection embeds) — but NOT on the Today sheet itself, which
 * renders the scratchpad under its own fixed heading. */
function scratchpadTitle(date: string): string {
  const label = new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return `${label} - Scratchpad`;
}

/** Find (or lazily create) the hidden scratchpad note for a date. If duplicate
 * notes exist for a date (e.g. a first-visit create race), prefer the one with
 * content, then the oldest — deterministically, so a day's note never "vanishes"
 * behind an empty twin. */
async function findOrCreateNote(userId: string, date: string) {
  // Opening a day brings its scratchpad into being whether or not anything is
  // typed, so take the opportunity to clear away the ones earlier visits left
  // empty. Best-effort, and never the note being opened — that one is
  // legitimately empty until its first keystroke.
  const sweep = (keepId: string) => void purgeEmptyAutoNotes(userId, keepId).catch(() => {});

  const [existing] = await db
    .select(blockView)
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), sql`${blocks.properties}->>'today_note' = ${date}`))
    .orderBy(sql`COALESCE(${blocks.content}, '') <> '' DESC`, blocks.createdAt)
    .limit(1);
  if (existing) {
    sweep(existing.id);
    // Backfill the title on notes created before scratchpads were titled.
    const props = (existing.properties ?? {}) as Record<string, unknown>;
    if (!props.title) {
      const nextProps = { ...props, title: scratchpadTitle(date) };
      await db
        .update(blocks)
        .set({ properties: nextProps })
        .where(and(eq(blocks.id, existing.id), eq(blocks.ownerId, userId)));
      return { ...existing, properties: nextProps };
    }
    return existing;
  }
  // Look up by the isText flag, not the (user-renameable) type name.
  const [textType] = await db
    .select({ id: blockTypes.id, schemaVersion: blockTypes.schemaVersion })
    .from(blockTypes)
    .where(and(eq(blockTypes.ownerId, userId), eq(blockTypes.isText, true)))
    .orderBy(desc(blockTypes.builtin))
    .limit(1);
  if (!textType) throw badRequest("text block type missing");
  // Whatever the last day that was written on is still sending forward comes
  // with it. The most recent day with anything in it, not simply yesterday:
  // a weekend, a week off, a stretch of days nobody opened — the thread
  // shouldn't drop because nothing was written on Sunday.
  const [previous] = await db
    .select({ content: blocks.content })
    .from(blocks)
    .where(
      and(
        eq(blocks.ownerId, userId),
        sql`${blocks.properties}->>'today_note' < ${date}`,
        sql`COALESCE(${blocks.content}, '') <> ''`,
        // A day that was opened and never written in is not the last day that
        // was written on, however much text it was handed.
        sql`${blocks.content} IS DISTINCT FROM ${blocks.properties}->>'seed'`,
      ),
    )
    .orderBy(sql`${blocks.properties}->>'today_note' DESC`)
    .limit(1);
  const seed = placeCarried("", carryForward(previous?.content));
  const [created] = await db
    .insert(blocks)
    .values({
      ownerId: userId,
      blockTypeId: textType.id,
      content: seed,
      properties: {
        today_note: date,
        title: scratchpadTitle(date),
        // What it opened with — see purgeEmptyAutoNotes.
        ...(seed ? { seed } : {}),
      },
      embedSource: seed,
      embedSourceHash: null,
      blockTypeSchemaVersion: textType.schemaVersion,
    })
    .returning(blockView);
  sweep(created!.id);
  return created!;
}

/** Excludes every kind of periodic note (daily scratchpads, weekly
 * reflections): they're system blocks, they're created merely by visiting the
 * page that owns them, and an empty one has no business in a day's listing. */
const notPeriodic = sql.join(
  PERIODIC_MARKERS.map((m) => sql`NOT jsonb_exists(${blocks.properties}, ${m})`),
  sql` AND `,
);

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

/**
 * A real calendar date, not just the right shape. `GET /today/:date` lazily
 * creates the day's note, so a loose pattern let a read verb mint rows for
 * ~10^8 impossible strings ("0000-00-00", "9999-99-99").
 */
const DATE = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}, "invalid calendar date");

/** Date portion of a "YYYY-MM-DD[THH:mm]" value, or null. */
function dateOf(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = v.split("T")[0];
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * A block is "relevant" to a date if any datetime/date property lands on it, or
 * the date falls within any datespan property (inclusive of start/end, ignoring
 * time).
 */
function isRelevant(
  schema: PropertySchema | null,
  props: Record<string, unknown>,
  date: string,
): boolean {
  if (!schema) return false;
  for (const f of schema.fields) {
    if (f.type === "datetime" || f.type === "date") {
      if (dateOf(props[f.key]) === date) return true;
    } else if (f.type === "datespan") {
      const span = props[f.key] as { start?: unknown; end?: unknown } | undefined;
      if (span && typeof span === "object") {
        const s = dateOf(span.start);
        const e = dateOf(span.end);
        if (s && s === date) return true;
        if (e && e === date) return true;
        if (s && e && s <= date && date <= e) return true;
      }
    }
  }
  return false;
}

/** Where the cross-day ("all Dailies" / "today-forward") default layout lives. */
const DEFAULT_PREF_KEY = "today_default";

async function loadDefaults(userId: string): Promise<DefaultTodayLayout> {
  const [row] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return normalizeDefaultLayout((row?.preferences ?? {})[DEFAULT_PREF_KEY]);
}

async function saveDefaults(userId: string, defaults: DefaultTodayLayout): Promise<void> {
  const [row] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const next = { ...(row?.preferences ?? {}), [DEFAULT_PREF_KEY]: defaults };
  await db
    .update(userSettings)
    .set({ preferences: next, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

/** A note's stored per-day layout + the global sections it suppresses. */
function noteLayoutState(note: { properties: unknown }): { layout: TodayLayout; suppress: string[] } {
  const props = (note.properties ?? {}) as Record<string, unknown>;
  const suppress = Array.isArray(props.layout_suppress)
    ? (props.layout_suppress as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  return { layout: normalizeTodayLayout(props.layout), suppress };
}

async function writeNoteLayout(
  userId: string,
  note: { id: string; properties: unknown },
  patch: { layout?: TodayLayout; suppress?: string[] },
): Promise<void> {
  const props = (note.properties ?? {}) as Record<string, unknown>;
  const nextProps: Record<string, unknown> = { ...props };
  if (patch.layout) nextProps.layout = normalizeTodayLayout(patch.layout);
  if (patch.suppress) nextProps.layout_suppress = [...new Set(patch.suppress)];
  await db
    .update(blocks)
    .set({ properties: nextProps, version: sql`${blocks.version} + 1`, updatedAt: new Date() })
    .where(and(eq(blocks.id, note.id), eq(blocks.ownerId, userId)));
}

/** Insert a custom section into a per-day layout just after its anchor (no-op
 * if already present). */
function insertAfter(
  layout: TodayLayout,
  section: CustomTodaySection,
  after: StandardTodaySection,
): TodayLayout {
  const key = sectionKey(section);
  if (layout.some((s) => sectionKey(s) === key)) return layout;
  const at = layout.findIndex((s) => s.t === after);
  const next = [...layout];
  next.splice(at < 0 ? next.length : at + 1, 0, section);
  return next;
}

/** Human labels for the given block/collection ids (title, else first content
 * line, else "Untitled"). */
async function labelsFor(userId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const rows = await db
    .select({ id: blocks.id, content: blocks.content, properties: blocks.properties })
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), inArray(blocks.id, ids)));
  for (const r of rows) {
    const title = (r.properties as Record<string, unknown>)?.title;
    const label =
      (typeof title === "string" && title.trim()) ||
      (r.content ?? "").split("\n")[0]?.trim() ||
      "Untitled";
    map.set(r.id, label);
  }
  return map;
}

const STD_LABELS: Record<StandardTodaySection, string> = {
  scratchpad: "Scratchpad",
  relevant: "Relevant today",
  activity: "Activity",
};

export async function todayRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  /** Dates that have a non-empty scratchpad note (for the calendar). */
  app.get("/today/dates", async (req) => {
    const userId = requireUser(req);
    // A day is "used" if anything was done to it that a default day wouldn't
    // have: text written, a section pinned or suppressed just for that day, or a
    // banner set. Text alone left a day you'd deliberately set up — a matrix
    // pinned to next Friday, say — looking identical to one nobody had touched.
    const rows = await db
      .select({ d: sql<string>`${blocks.properties}->>'today_note'` })
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`jsonb_exists(${blocks.properties}, 'today_note')`,
          sql`${blocks.archivedAt} IS NULL`,
          sql`(
            (
              COALESCE(${blocks.content}, '') <> ''
              -- A day handed a template it was never written in isn't a day
              -- with something on it.
              AND ${blocks.content} IS DISTINCT FROM ${blocks.properties}->>'seed'
            )
            OR jsonb_array_length(COALESCE(${blocks.properties}->'layout', '[]'::jsonb)) > 0
            OR jsonb_array_length(COALESCE(${blocks.properties}->'layout_suppress', '[]'::jsonb)) > 0
            OR jsonb_exists(${blocks.properties}, 'banner')
          )`,
        ),
      );
    return [...new Set(rows.map((r) => r.d).filter(Boolean))];
  });

  /**
   * Just the day's note, brought into being if this is the first time anyone has
   * asked for it. A daily note exists because someone opened the day — an agent
   * asking for one over MCP is the same act, and it shouldn't have to build the
   * note itself (or discover that "today's note" doesn't exist and give up).
   * Registered before "/today/:date" so the literal path wins.
   */
  app.get("/today/:date/note", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);
    return findOrCreateNote(userId, date);
  });

  /** The Today sheet for a date: scratchpad note + relevant + activity blocks. */
  app.get("/today/:date", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);

    const note = await findOrCreateNote(userId, date);

    // Activity: blocks created or edited on this date, in the user's timezone.
    const [tzRow] = await db
      .select({ tz: userSettings.timezone })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    const { start, end } = zonedDayRange(date, tzRow?.tz ?? null);
    const activity = await db
      .select(blockView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          // Collections count as activity too: making a canvas or a list is one
          // of the more memorable things you do in a day, and leaving them out
          // meant a day's record could show nothing at all for it.
          notPeriodic,
          sql`${blocks.archivedAt} IS NULL`,
          or(
            and(gte(blocks.createdAt, start), lt(blocks.createdAt, end)),
            and(gte(blocks.updatedAt, start), lt(blocks.updatedAt, end)),
          ),
        ),
      )
      .orderBy(sql`${blocks.updatedAt} DESC`)
      .limit(500);

    // Relevant: schema-aware, filtered in JS over candidate blocks.
    const types = await db
      .select({ id: blockTypes.id, schema: blockTypes.propertySchema })
      .from(blockTypes)
      .where(eq(blockTypes.ownerId, userId));
    const schemaById = new Map(types.map((t) => [t.id, t.schema]));
    const candidates = await db
      .select(blockView)
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.collectionKind} IS NULL`,
          notPeriodic,
          sql`${blocks.archivedAt} IS NULL`,
        ),
      )
      .limit(2000);
    const relevant = candidates.filter((b) =>
      isRelevant(
        b.blockTypeId ? schemaById.get(b.blockTypeId) ?? null : null,
        b.properties as Record<string, unknown>,
        date,
      ),
    );

    const { layout: dayLayout, suppress } = noteLayoutState(note);
    const defaults = await loadDefaults(userId);
    const layout = composeTodayLayout(dayLayout, suppress, defaults, date);
    return { note, relevant, activity, layout };
  });

  /** Persist the ordered section layout for a date's Today sheet. Sections that
   * belong to a covering default are NOT written into the day's own storage
   * (composition re-injects them), so a plain reorder can't silently pin a
   * global "all Dailies" section to a single day. */
  app.put("/today/:date/layout", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);
    const { layout } = z.object({ layout: todayLayoutSchema }).parse(req.body);
    const note = await findOrCreateNote(userId, date);
    const defaults = await loadDefaults(userId);
    const covered = new Set(
      defaults.filter((e) => rangeCovers(e, date)).map((e) => sectionKey(e.section)),
    );
    const dayOnly = normalizeTodayLayout(layout).filter(
      (s) => (s.t !== "collection" && s.t !== "block") || !covered.has(sectionKey(s)),
    );
    await writeNoteLayout(userId, note, { layout: dayOnly });
    return { layout: composeTodayLayout(dayOnly, noteLayoutState(note).suppress, defaults, date) };
  });

  /** Inspect the cross-day default layout (the "all Dailies" entries). */
  app.get("/today/default", async (req) => {
    const userId = requireUser(req);
    return { default: await loadDefaults(userId) };
  });

  /** The composed layout for a date, each section tagged with its source and
   * (for defaults) its scope/range — the read behind the today_layout_get MCP
   * tool. */
  app.get("/today/:date/layout", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);
    const note = await findOrCreateNote(userId, date);
    const { layout: dayLayout, suppress } = noteLayoutState(note);
    const defaults = await loadDefaults(userId);
    const composed = composeTodayLayout(dayLayout, suppress, defaults, date);
    const daySet = new Set(dayLayout.map(sectionKey));

    const ids = composed
      .filter((s): s is Extract<typeof s, { id: string }> => s.t === "collection" || s.t === "block")
      .map((s) => s.id);
    const labels = await labelsFor(userId, ids);

    const sections = composed.map((s) => {
      if (s.t !== "collection" && s.t !== "block") {
        return { t: s.t, label: STD_LABELS[s.t], source: "standard" as const };
      }
      const key = sectionKey(s);
      const def = defaults.find((e) => sectionKey(e.section) === key && rangeCovers(e, date));
      const scope = def
        ? def.from == null && def.until == null
          ? ("all" as const)
          : def.until == null
            ? ("today_forward" as const)
            : ("range" as const)
        : null;
      return {
        t: s.t,
        id: s.id,
        label: labels.get(s.id) ?? "Untitled",
        source: daySet.has(key) ? ("day" as const) : ("default" as const),
        scope,
        range: def ? { from: def.from, until: def.until } : undefined,
      };
    });
    return { date, sections };
  });

  const addBody = z.object({
    section: customTodaySectionSchema,
    after: z.enum(STANDARD_TODAY_SECTIONS).default("scratchpad"),
    scope: todayScopeSchema.default("today"),
  });

  /** Add a collection/note section to a date's sheet at the given scope. */
  app.post("/today/:date/layout/add", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);
    const { section, after, scope } = addBody.parse(req.body);
    const note = await findOrCreateNote(userId, date);
    const state = noteLayoutState(note);
    const key = sectionKey(section);
    // Adding always un-hides the section for this day.
    const suppress = state.suppress.filter((k) => k !== key);

    if (scope === "today") {
      await writeNoteLayout(userId, note, { layout: insertAfter(state.layout, section, after), suppress });
    } else {
      const defaults = addToDefaults(await loadDefaults(userId), section, after, scope, date);
      await saveDefaults(userId, defaults);
      if (suppress.length !== state.suppress.length) await writeNoteLayout(userId, note, { suppress });
    }
    const defaults = await loadDefaults(userId);
    return { layout: composeTodayLayout(noteLayoutState(note).layout, suppress, defaults, date) };
  });

  const removeBody = z.object({
    section: customTodaySectionSchema,
    scope: todayScopeSchema.default("today"),
  });

  /** Remove a section from a date's sheet at the given scope. */
  app.post("/today/:date/layout/remove", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);
    const { section, scope } = removeBody.parse(req.body);
    const note = await findOrCreateNote(userId, date);
    const state = noteLayoutState(note);
    const key = sectionKey(section);
    const dayLocal = state.layout.some((s) => sectionKey(s) === key);
    const defaults = await loadDefaults(userId);
    const covered = defaults.some((e) => sectionKey(e.section) === key && rangeCovers(e, date));

    if (scope === "today") {
      // Drop a day-local add; suppress a covering default for just this day.
      const layout = dayLocal ? state.layout.filter((s) => sectionKey(s) !== key) : undefined;
      const suppress = covered ? [...state.suppress, key] : undefined;
      if (layout || suppress) await writeNoteLayout(userId, note, { layout, suppress });
    } else {
      // Cross-day: prune the default, and also drop today's day-local copy.
      await saveDefaults(userId, removeFromDefaults(defaults, key, scope, date));
      if (dayLocal) {
        await writeNoteLayout(userId, note, {
          layout: state.layout.filter((s) => sectionKey(s) !== key),
        });
      }
    }
    const fresh = noteLayoutState(await findOrCreateNote(userId, date));
    return { layout: composeTodayLayout(fresh.layout, fresh.suppress, await loadDefaults(userId), date) };
  });
}
