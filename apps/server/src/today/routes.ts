import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addToDefaults,
  carryForward,
  datedInRange,
  composeTodayLayout,
  DAILY_TEMPLATE_PREF,
  fromMark,
  placeCarried,
  removeMarked,
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
import { templateBody } from "../blocks/routes.js";
import { db } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { effectiveTimeZone, zonedDayRange } from "../lib/timezone.js";
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

/**
 * What a note for this date should open with: the shape chosen for daily
 * notes, with whatever the last day that was written on is still sending
 * forward set down where that shape asks for it.
 *
 * The most recent day with writing in it, not simply yesterday — a weekend, a
 * week off, a run of days nobody opened: the thread shouldn't drop because
 * nothing was written on Sunday.
 */
async function seedFor(userId: string, date: string): Promise<string> {
  const [previous] = await db
    .select({ content: blocks.content, day: sql<string>`${blocks.properties}->>'today_note'` })
    .from(blocks)
    .where(
      and(
        eq(blocks.ownerId, userId),
        sql`${blocks.properties}->>'today_note' < ${date}`,
        sql`COALESCE(${blocks.content}, '') <> ''`,
        // A day that was opened and never written in is not the last day that
        // was written on, however much text it was handed.
        sql`regexp_replace(COALESCE(${blocks.content}, ''), '\\s+$', '') IS DISTINCT FROM regexp_replace(COALESCE(${blocks.properties}->>'seed', ''), '\\s+$', '')`,
      ),
    )
    .orderBy(sql`${blocks.properties}->>'today_note' DESC`)
    .limit(1);
  const [prefRow] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const shape = await templateBody(userId, (prefRow?.preferences ?? {})[DAILY_TEMPLATE_PREF]);
  return placeCarried(shape, carryForward(previous?.content, previous?.day));
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
    const props = (existing.properties ?? {}) as Record<string, unknown>;
    // A day opened before anything was sent forward — flicking ahead in the
    // calendar makes its note — would otherwise keep the empty page it was
    // born with for ever, while every later day got the text. Nothing here is
    // anybody's writing until it differs from what it was handed, so it can
    // be handed something newer.
    // Empty, or still holding exactly what it was handed: either way nobody has
    // written in it, so it takes a fresh page. Emptying one and finding the
    // carried text back is fine — that text is what the day is meant to open
    // with. What matters is that a day like this doesn't count as a day with
    // something on it (see /today/dates) or linger once it's left (see
    // purgeEmptyAutoNotes).
    // Trailing whitespace ignored on both sides: the seed ends with a blank
    // line so writing starts on clean paper, and the editor trims that away
    // on its first save — leaving a note holding exactly its seed's words
    // while comparing unequal to it.
    const bare = (v: string) => v.replace(/\s+$/, "");
    const untouched =
      (existing.content ?? "") === "" ||
      bare(existing.content ?? "") === bare(String(props.seed ?? "\u0000"));
    if (untouched) {
      const seed = await seedFor(userId, date);
      if (seed !== (existing.content ?? "")) {
        const nextProps = { ...props, title: props.title ?? scratchpadTitle(date), seed };
        await db
          .update(blocks)
          .set({ content: seed, properties: nextProps, embedSource: seed, embedSourceHash: null })
          .where(and(eq(blocks.id, existing.id), eq(blocks.ownerId, userId)));
        return { ...existing, content: seed, properties: nextProps };
      }
    }
    // Backfill the title on notes created before scratchpads were titled.
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
  const seed = await seedFor(userId, date);
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

/**
 * Whether a day is still exactly as it opens: holding what it was handed and
 * nothing arranged on it. The same four questions the calendar asks before it
 * marks a day (see /today/dates), asked of one note — so a day the calendar
 * doesn't mark is a day the Today page won't offer to reset, there being
 * nothing to put back.
 *
 * Trailing whitespace ignored, because the seed ends with a blank line and the
 * editor trims that away on its first save.
 */
function isPristine(note: { content: string | null; properties: unknown }): boolean {
  const props = (note.properties ?? {}) as Record<string, unknown>;
  const bare = (v: string) => v.replace(/\s+$/, "");
  const asHanded = bare(note.content ?? "") === bare(String(props.seed ?? ""));
  const arranged =
    (Array.isArray(props.layout) && props.layout.length > 0) ||
    (Array.isArray(props.layout_suppress) && props.layout_suppress.length > 0) ||
    props.banner != null;
  return asHanded && !arranged;
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
  return datedInRange(schema, props, date, date);
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
              -- with something on it. Trailing whitespace ignored: the seed
              -- ends with a blank line, which the editor trims on first save.
              AND regexp_replace(COALESCE(${blocks.content}, ''), '\\s+$', '') IS DISTINCT FROM regexp_replace(COALESCE(${blocks.properties}->>'seed', ''), '\\s+$', '')
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

  /**
   * Put a piece of text on particular days.
   *
   * Sending text forward hands it to tomorrow, and the day after, and on until
   * you call it off — right for a question you're sitting with, wrong for a
   * thing that belongs to next Tuesday. This sets the words down on the days
   * you name and leaves them there: they arrive marked with the day they came
   * from, so you know why they're in front of you, and they travel no further.
   *
   * A day nobody has opened is brought into being to receive them, exactly as
   * visiting it would.
   */
  app.post("/today/send", async (req) => {
    const userId = requireUser(req);
    const { text, from, dates } = z
      .object({
        text: z.string().min(1).max(20_000),
        from: DATE,
        // Capped: this is a hand-picked list from a calendar, and an unbounded
        // one would mint a note per entry.
        dates: z.array(DATE).min(1).max(60),
      })
      .parse(req.body);

    // Strictly later than the note it's leaving. Dates sort as strings, so this
    // is the comparison it looks like. The picker also keeps you out of days
    // already gone; that floor is the browser's, since only it knows what day
    // it is where the reader is sitting.
    const targets = [...new Set(dates)].filter((d) => d > from).sort();
    const sent: string[] = [];
    for (const day of targets) {
      const note = await findOrCreateNote(userId, day);
      const before = (note.content ?? "").replace(/\s+$/, "");
      // A blank line between what was there and what's arriving: two paragraphs
      // run together otherwise, and a bullet list appended to a paragraph would
      // swallow the first item.
      const content = before
        ? `${before}\n\n${fromMark(text, from)}\n`
        : `${fromMark(text, from)}\n`;
      await db
        .update(blocks)
        .set({
          content,
          embedSource: content,
          embedSourceHash: null,
          version: sql`${blocks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(blocks.id, note.id), eq(blocks.ownerId, userId)));
      sent.push(day);
    }
    return { sent };
  });

  /**
   * Take a piece of text back out of the days ahead.
   *
   * Calling something off says you're done with it, and days that haven't
   * happened yet shouldn't still be holding it — whether it was going to arrive
   * there by traveling or was set down on that day by hand. Days already past
   * keep every word: what you wrote on Tuesday is what you wrote on Tuesday,
   * and this has never rewritten history.
   *
   * `after` comes from the reader's own clock rather than this one, which can be
   * a day out from theirs (see the timezone setting).
   */
  app.post("/today/retract", async (req) => {
    const userId = requireUser(req);
    const { text, after } = z
      .object({ text: z.string().min(1).max(20_000), after: DATE })
      .parse(req.body);

    const rows = await db
      .select({ id: blocks.id, content: blocks.content })
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          sql`${blocks.properties}->>'today_note' > ${after}`,
          sql`${blocks.archivedAt} IS NULL`,
        ),
      );
    const cleared: string[] = [];
    for (const row of rows) {
      const next = removeMarked(row.content, text);
      if (next === (row.content ?? "")) continue;
      await db
        .update(blocks)
        .set({
          content: next,
          embedSource: next,
          embedSourceHash: null,
          version: sql`${blocks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(blocks.id, row.id), eq(blocks.ownerId, userId)));
      cleared.push(row.id);
    }
    return { cleared };
  });

  /**
   * Put a day back to the page it would have opened with — the daily template
   * with whatever the last written-in day is sending forward set down in it —
   * as though nobody had ever been here.
   *
   * Emptying the box by hand doesn't do this and can't: the note is left
   * holding nothing, which every re-seed reads as a day still waiting for its
   * page, so the next visit fills it back up. Writing the seed IS the reset,
   * and it lands the day back in the state everything else already knows how
   * to read — the calendar stops marking it as one you've been in, and the
   * sweep will take the note away in its own time, exactly as it does for a day
   * that was opened and never written in.
   *
   * The day's own arrangement goes too: sections pinned to this day alone,
   * standing ones it was suppressing, its banner. They're things done to the
   * day as much as the writing is, and a day still wearing them isn't one that
   * was never opened.
   */
  app.post("/today/:date/reset", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);
    const note = await findOrCreateNote(userId, date);
    const props = (note.properties ?? {}) as Record<string, unknown>;
    const seed = await seedFor(userId, date);
    // Rebuilt rather than pared down, so a key added to daily notes later can't
    // survive a reset by having been forgotten here: what a fresh note is made
    // with is what a reset one is left with.
    const properties: Record<string, unknown> = {
      today_note: props.today_note ?? date,
      title: props.title ?? scratchpadTitle(date),
      ...(seed ? { seed } : {}),
    };
    const [updated] = await db
      .update(blocks)
      .set({
        content: seed,
        properties,
        embedSource: seed,
        embedSourceHash: null,
        version: sql`${blocks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(blocks.id, note.id), eq(blocks.ownerId, userId)))
      .returning(blockView);
    return updated ?? { ...note, content: seed, properties };
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
    const { start, end } = zonedDayRange(date, effectiveTimeZone(tzRow?.tz));
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
    return { note, relevant, activity, layout, pristine: isPristine(note) };
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

  const rescopeBody = z.object({
    section: customTodaySectionSchema,
    scope: todayScopeSchema,
  });

  /**
   * Change what a section already on this sheet means: something added just
   * for today becomes part of every day from here, or a standing section stops
   * standing and stays only on this one.
   *
   * Re-deciding is not the same as removing and adding back — that loses where
   * the section sits — so the anchor it's under is read off the sheet as it
   * stands and carried over.
   */
  app.post("/today/:date/layout/rescope", async (req) => {
    const userId = requireUser(req);
    const { date } = z.object({ date: DATE }).parse(req.params);
    const { section, scope } = rescopeBody.parse(req.body);
    const note = await findOrCreateNote(userId, date);
    const state = noteLayoutState(note);
    const key = sectionKey(section);
    let defaults = await loadDefaults(userId);

    // Which standard section it currently sits under, so it lands back in the
    // same place rather than at the top.
    const composed = composeTodayLayout(state.layout, state.suppress, defaults, date);
    let after: StandardTodaySection = "scratchpad";
    for (const sec of composed) {
      if (sectionKey(sec) === key) break;
      if (sec.t !== "collection" && sec.t !== "block") after = sec.t;
    }

    const dayLocal = state.layout.some((x) => sectionKey(x) === key);
    if (scope === "today") {
      // Stop standing from here on, and keep it on this day by name.
      defaults = removeFromDefaults(defaults, key, "today_forward", date);
      await saveDefaults(userId, defaults);
      await writeNoteLayout(userId, note, {
        layout: dayLocal ? state.layout : insertAfter(state.layout, section, after),
        suppress: state.suppress.filter((k) => k !== key),
      });
    } else {
      // Make it standing, and drop the day-local copy so it isn't counted twice.
      defaults = addToDefaults(defaults, section, after, scope, date);
      await saveDefaults(userId, defaults);
      await writeNoteLayout(userId, note, {
        layout: dayLocal ? state.layout.filter((x) => sectionKey(x) !== key) : state.layout,
        suppress: state.suppress.filter((k) => k !== key),
      });
    }
    const fresh = noteLayoutState(await findOrCreateNote(userId, date));
    return { layout: composeTodayLayout(fresh.layout, fresh.suppress, await loadDefaults(userId), date) };
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
