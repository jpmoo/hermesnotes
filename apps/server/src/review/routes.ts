import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  carryForward,
  composeReviewSteps,
  WEEKLY_TEMPLATE_PREF,
  placeCarried,
  isComplete,
  parseWeeklyReview,
  reorderReviewSteps,
  resetReviewCycle,
  reviewLinkSchema,
  userLocalNow,
  WEEKLY_REVIEW_PREF_KEY,
  type PropertySchema,
  type ReviewStep,
  type WeeklyReview,
} from "@hermes/shared";
import { blocks, blockTypes, userSettings } from "@hermes/db";
import { templateBody } from "../blocks/routes.js";
import { db } from "../db.js";
import { syncSeries } from "../blocks/series.js";
import { badRequest, notFound } from "../lib/errors.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { purgeEmptyAutoNotes } from "../blocks/auto-notes.js";
import { computeEmbedSource } from "../blocks/embed-source.js";
import { effectiveTimeZone } from "../lib/timezone.js";

/**
 * Weekly review: a guided, ordered set of steps driven by a recurring "Do weekly
 * review" task. The config (template steps, schedule, per-cycle progress) lives
 * in user_settings.preferences[weekly_review]; the task and the per-week
 * "reflection" are real blocks. Progress resets when a new review opens.
 */

const REVIEW_TASK_TITLE = "Do weekly review";
const REFLECTION_MARK = "review_reflection"; // properties key: the cycle's due date

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The next date on or after `from` that falls on `weekday` (0=Sun … 6=Sat). */
function nextWeekdayOnOrAfter(from: Date, weekday: number): Date {
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return addDays(base, (weekday - base.getDay() + 7) % 7);
}

/** The review task's span for the coming cycle: due on the chosen weekday,
 *  available `availPrior` days earlier (or no available date when 0). */
function computeSpan(now: Date, dueWeekday: number, availPrior: number): { start?: string; end: string } {
  const due = nextWeekdayOnOrAfter(now, dueWeekday);
  return { ...(availPrior > 0 ? { start: ymd(addDays(due, -availPrior)) } : {}), end: ymd(due) };
}

const dateOf = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const d = v.split("T")[0];
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

const fmtWeekEnding = (dueDate: string): string =>
  `Review Reflection for Week Ending ${new Date(`${dueDate}T00:00:00`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  })}`;

interface TaskType {
  id: string;
  schemaVersion: number;
  isText: boolean;
  propertySchema: PropertySchema | null;
}

/** The user's task type (builtin "task", or any status+datespan type). */
async function resolveTaskType(userId: string): Promise<TaskType> {
  const types = await db
    .select({
      id: blockTypes.id,
      name: blockTypes.name,
      builtin: blockTypes.builtin,
      isText: blockTypes.isText,
      schemaVersion: blockTypes.schemaVersion,
      propertySchema: blockTypes.propertySchema,
    })
    .from(blockTypes)
    .where(eq(blockTypes.ownerId, userId));
  const task =
    types.find((t) => t.builtin && t.name.trim().toLowerCase() === "task") ??
    types.find(
      (t) => t.propertySchema?.status_field && t.propertySchema.fields.some((f) => f.type === "datespan"),
    );
  if (!task) throw badRequest("No task type found — can't manage the weekly review.");
  return task;
}

const taskView = {
  id: blocks.id,
  properties: blocks.properties,
  version: blocks.version,
  seriesId: blocks.seriesId,
};

/** The current (incomplete, unarchived) "Do weekly review" task, newest first. */
async function findActiveReviewTask(userId: string, task: TaskType) {
  const rows = await db
    .select(taskView)
    .from(blocks)
    .where(
      and(
        eq(blocks.ownerId, userId),
        sql`${blocks.properties}->>'weekly_review' = 'true'`,
        isNull(blocks.archivedAt),
      ),
    )
    .orderBy(desc(blocks.createdAt));
  const schema = task.propertySchema;
  return rows.find((r) => !(schema && isComplete(schema, (r.properties ?? {}) as Record<string, unknown>))) ?? null;
}

/** Recurrence rule for the review: weekly on the chosen weekday, forever. */
function reviewRecurrence(dueWeekday: number) {
  return {
    completeFrom: "scheduled" as const,
    frequency: "weekly" as const,
    interval: 1,
    weekdays: [dueWeekday],
    end: { type: "never" as const },
    n: 1,
  };
}

/** Ensure a "Do weekly review" task exists and matches the configured schedule. */
async function provisionReviewTask(userId: string, wr: WeeklyReview, tz: string | null): Promise<void> {
  if (wr.dueWeekday === null) return;
  const task = await resolveTaskType(userId);
  const schema = task.propertySchema;
  const statusKey = schema?.status_field ?? "status";
  const spanField = schema?.fields.find((f) => f.type === "datespan");
  const recField = schema?.fields.find((f) => f.type === "recurrence");
  const spanKey = spanField?.key ?? "schedule";
  const recKey = recField?.key ?? "recurrence";

  // The task's project reference field (if any) — filed under the chosen project.
  const projRefKey = schema?.fields.find((f) => f.type === "reference")?.key;

  const span = computeSpan(userLocalNow(effectiveTimeZone(tz)), wr.dueWeekday, wr.availableDaysPrior);
  const rec = reviewRecurrence(wr.dueWeekday);

  const active = await findActiveReviewTask(userId, task);
  if (active) {
    // Re-point the live task at the new schedule; keep its status/progress.
    const props = { ...((active.properties ?? {}) as Record<string, unknown>) };
    props[spanKey] = span;
    props[recKey] = { ...rec, n: (props[recKey] as { n?: number })?.n ?? 1 };
    props.weekly_review = true;
    if (projRefKey) props[projRefKey] = wr.project;
    const embedSource = computeEmbedSource({ isText: task.isText, propertySchema: schema }, { properties: props });
    await db
      .update(blocks)
      .set({ properties: props, embedSource, embedSourceHash: null, version: sql`${blocks.version} + 1` })
      .where(and(eq(blocks.id, active.id), eq(blocks.ownerId, userId)));
    // This writes the block directly rather than through PATCH, so the sync that
    // keeps a series in step with its rule has to be asked for by name. A second
    // writer that forgets is exactly how the two copies drift apart.
    await syncSeries(userId, active.id, active.seriesId ?? null, schema, props);
    return;
  }
  const props: Record<string, unknown> = {
    title: REVIEW_TASK_TITLE,
    [statusKey]: schema?.default_value ?? "not_started",
    [spanKey]: span,
    [recKey]: rec,
    weekly_review: true,
    ...(projRefKey ? { [projRefKey]: wr.project } : {}),
  };
  const embedSource = computeEmbedSource({ isText: task.isText, propertySchema: schema }, { properties: props });
  const [made] = await db
    .insert(blocks)
    .values({
      ownerId: userId,
      blockTypeId: task.id,
      content: null,
      properties: props,
      embedSource,
      embedSourceHash: null,
      blockTypeSchemaVersion: task.schemaVersion,
    })
    .returning({ id: blocks.id });
  if (made) await syncSeries(userId, made.id, null, schema, props);
}

/** Find (or lazily create) the reflection note for a cycle's due date. */
async function findOrCreateReflection(userId: string, dueDate: string): Promise<string> {
  // An open review conjures its reflection note whether or not it is written in,
  // so clear away the ones earlier cycles left empty. Best-effort, and never the
  // note in hand.
  const sweep = (keepId: string) => void purgeEmptyAutoNotes(userId, keepId).catch(() => {});
  const [existing] = await db
    .select({ id: blocks.id })
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), sql`${blocks.properties}->>${REFLECTION_MARK} = ${dueDate}`))
    .orderBy(sql`COALESCE(${blocks.content}, '') <> '' DESC`, blocks.createdAt)
    .limit(1);
  if (existing) {
    sweep(existing.id);
    return existing.id;
  }
  const [textType] = await db
    .select({ id: blockTypes.id, schemaVersion: blockTypes.schemaVersion })
    .from(blockTypes)
    .where(and(eq(blockTypes.ownerId, userId), eq(blockTypes.isText, true)))
    .orderBy(desc(blockTypes.builtin))
    .limit(1);
  if (!textType) throw badRequest("text block type missing");
  // Same thread as the daily notes, on its own cadence: the last reflection
  // that had anything in it, skipping the weeks nobody wrote one.
  const [previous] = await db
    .select({
      content: blocks.content,
      day: sql<string>`${blocks.properties}->>${REFLECTION_MARK}`,
    })
    .from(blocks)
    .where(
      and(
        eq(blocks.ownerId, userId),
        sql`${blocks.properties}->>${REFLECTION_MARK} < ${dueDate}`,
        sql`COALESCE(${blocks.content}, '') <> ''`,
        sql`${blocks.content} IS DISTINCT FROM ${blocks.properties}->>'seed'`,
      ),
    )
    .orderBy(sql`${blocks.properties}->>${REFLECTION_MARK} DESC`)
    .limit(1);
  const [prefRow] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const shape = await templateBody(userId, (prefRow?.preferences ?? {})[WEEKLY_TEMPLATE_PREF]);
  const seed = placeCarried(shape, carryForward(previous?.content, previous?.day));
  const [created] = await db
    .insert(blocks)
    .values({
      ownerId: userId,
      blockTypeId: textType.id,
      content: seed,
      properties: {
        [REFLECTION_MARK]: dueDate,
        title: fmtWeekEnding(dueDate),
        ...(seed ? { seed } : {}),
      },
      embedSource: seed,
      embedSourceHash: null,
      blockTypeSchemaVersion: textType.schemaVersion,
    })
    .returning({ id: blocks.id });
  sweep(created!.id);
  return created!.id;
}

/** Resolve display labels for the blocks/collections steps link to. */
async function resolveLabels(userId: string, steps: ReviewStep[]): Promise<Map<string, string>> {
  const ids = [...new Set(steps.map((s) => s.link?.id).filter((v): v is string => !!v))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: blocks.id, properties: blocks.properties })
    .from(blocks)
    .where(and(eq(blocks.ownerId, userId), inArray(blocks.id, ids)));
  for (const r of rows) {
    const p = (r.properties ?? {}) as Record<string, unknown>;
    out.set(r.id, String(p.title ?? "Untitled"));
  }
  return out;
}

async function loadState(userId: string): Promise<{ wr: WeeklyReview; timezone: string | null }> {
  const [row] = await db
    .select({ preferences: userSettings.preferences, timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (!row) throw notFound("settings");
  return { wr: parseWeeklyReview((row.preferences ?? {})[WEEKLY_REVIEW_PREF_KEY]), timezone: row.timezone };
}

async function saveWeeklyReview(userId: string, wr: WeeklyReview): Promise<void> {
  const [row] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (!row) throw notFound("settings");
  const next = { ...(row.preferences ?? {}), [WEEKLY_REVIEW_PREF_KEY]: wr };
  await db.update(userSettings).set({ preferences: next, updatedAt: new Date() }).where(eq(userSettings.userId, userId));
}

/**
 * Build the full page state: the live task's dates, whether the review is open,
 * the composed steps with per-cycle done flags, and the reflection block. Also
 * performs the lazy per-cycle reset (a new review clears prior progress).
 */
async function buildState(userId: string) {
  let { wr, timezone } = await loadState(userId);
  if (wr.dueWeekday === null) return { configured: false as const };

  const task = await resolveTaskType(userId);
  // Do NOT provision here: a read must be side-effect-free, and two concurrent
  // GETs (tabs, live-sync) both seeing no active task would each insert one.
  // Provisioning happens only on the explicit config save (find-or-update).
  const active = await findActiveReviewTask(userId, task);
  const props = (active?.properties ?? {}) as Record<string, unknown>;
  const schema = task.propertySchema;
  const statusKey = schema?.status_field ?? "status";
  // The value that marks the task complete: prefer "done", else the first
  // complete value the (possibly custom) type defines.
  const completeVals = schema?.complete_values ?? [];
  const doneValue = completeVals.includes("done") ? "done" : completeVals[0] ?? "done";
  const spanKey = schema?.fields.find((f) => f.type === "datespan")?.key ?? "schedule";
  const span = (props[spanKey] ?? {}) as { start?: string; end?: string };
  const available = dateOf(span.start);
  const due = dateOf(span.end);
  const cycleKey = available ?? due ?? "";

  const nowYmd = ymd(userLocalNow(effectiveTimeZone(timezone)));
  const isOpen = cycleKey ? nowYmd >= cycleKey : true;
  // A newly-available cycle clears the prior review's progress.
  if (isOpen && cycleKey && wr.cycle.key !== cycleKey) {
    wr = resetReviewCycle(wr, cycleKey);
    await saveWeeklyReview(userId, wr);
  }

  const composed = composeReviewSteps(wr);
  const done = new Set(wr.cycle.done);
  const labels = await resolveLabels(userId, composed);
  const steps = composed.map((s) => ({
    id: s.id,
    description: s.description,
    link: s.link,
    label: s.link ? labels.get(s.link.id) ?? "Untitled" : null,
    template: wr.steps.some((t) => t.id === s.id),
    done: done.has(s.id),
  }));
  // Only create the reflection once the review is actually open (don't spawn an
  // empty "Week Ending …" note before the week begins).
  const reflectionBlockId = due && isOpen ? await findOrCreateReflection(userId, due) : null;

  return {
    configured: true as const,
    dueWeekday: wr.dueWeekday,
    availableDaysPrior: wr.availableDaysPrior,
    project: wr.project,
    statusKey,
    doneValue,
    task: active
      ? {
          id: active.id,
          status: String(props[statusKey] ?? ""),
          done: schema ? isComplete(schema, props) : false,
          available,
          due,
        }
      : null,
    open: isOpen,
    steps,
    allDone: steps.length > 0 && steps.every((s) => s.done),
    reflectionBlockId,
    reflectionTitle: due ? fmtWeekEnding(due) : "",
  };
}

const stepBodySchema = z.object({
  description: z.string().max(4000).default(""),
  link: reviewLinkSchema.nullable().default(null),
  scope: z.enum(["template", "cycle"]).default("template"),
});

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/review", async (req) => buildState(requireUser(req)));

  /** Set the review schedule (and create/update the managed task). Weekday null
   *  turns the feature off — the icon disappears; the task is left as-is. */
  app.put("/review/config", async (req) => {
    const userId = requireUser(req);
    const body = z
      .object({
        dueWeekday: z.number().int().min(0).max(6).nullable(),
        availableDaysPrior: z.number().int().min(0).max(6).default(0),
        project: z.array(z.string().uuid()).max(20).optional(),
      })
      .parse(req.body);
    const { wr, timezone } = await loadState(userId);
    const next: WeeklyReview = {
      ...wr,
      dueWeekday: body.dueWeekday,
      availableDaysPrior: body.availableDaysPrior,
      ...(body.project !== undefined ? { project: body.project } : {}),
    };
    await saveWeeklyReview(userId, next);
    if (next.dueWeekday !== null) {
      await provisionReviewTask(userId, next, timezone);
    } else {
      // Turning the feature off: unmark the managed task(s) so they become plain
      // tasks — otherwise the archive guard keeps a half-finished one stuck.
      await db
        .update(blocks)
        .set({ properties: sql`${blocks.properties} - 'weekly_review'`, version: sql`${blocks.version} + 1` })
        .where(
          and(
            eq(blocks.ownerId, userId),
            sql`${blocks.properties}->>'weekly_review' = 'true'`,
            isNull(blocks.archivedAt),
          ),
        );
    }
    return buildState(userId);
  });

  /** Add a step — to the template (all future reviews) or just this cycle. */
  app.post("/review/steps", async (req) => {
    const userId = requireUser(req);
    const body = stepBodySchema.parse(req.body);
    const { wr } = await loadState(userId);
    const step: ReviewStep = { id: crypto.randomUUID(), description: body.description, link: body.link };
    const next =
      body.scope === "cycle"
        ? { ...wr, cycle: { ...wr.cycle, extras: [...wr.cycle.extras, step] } }
        : { ...wr, steps: [...wr.steps, step] };
    await saveWeeklyReview(userId, next);
    return buildState(userId);
  });

  /** Edit a step's description/link, and optionally move it between the template
   *  ("all future reviews") and this cycle's extras ("this review only"). */
  app.patch("/review/steps/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        description: z.string().max(4000).optional(),
        link: reviewLinkSchema.nullable().optional(),
        scope: z.enum(["template", "cycle"]).optional(),
      })
      .parse(req.body);
    const { wr } = await loadState(userId);

    const inTemplate = wr.steps.find((s) => s.id === id);
    const existing = inTemplate ?? wr.cycle.extras.find((s) => s.id === id);
    if (!existing) throw badRequest("No such review step.");
    const updated: ReviewStep = {
      ...existing,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.link !== undefined ? { link: body.link } : {}),
    };
    const currentScope: "template" | "cycle" = inTemplate ? "template" : "cycle";
    const targetScope = body.scope ?? currentScope;

    let next: WeeklyReview;
    if (targetScope === currentScope) {
      // Patch in place — preserve position.
      next = {
        ...wr,
        steps: wr.steps.map((s) => (s.id === id ? updated : s)),
        cycle: { ...wr.cycle, extras: wr.cycle.extras.map((s) => (s.id === id ? updated : s)) },
      };
    } else {
      // Move to the other list (keeps its id, so done/order references stay valid).
      const steps = wr.steps.filter((s) => s.id !== id);
      const extras = wr.cycle.extras.filter((s) => s.id !== id);
      next = {
        ...wr,
        steps: targetScope === "template" ? [...steps, updated] : steps,
        cycle: { ...wr.cycle, extras: targetScope === "cycle" ? [...extras, updated] : extras },
      };
    }
    await saveWeeklyReview(userId, next);
    return buildState(userId);
  });

  /** Remove a step (from wherever it lives). */
  app.delete("/review/steps/:id", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { wr } = await loadState(userId);
    const next: WeeklyReview = {
      ...wr,
      steps: wr.steps.filter((s) => s.id !== id),
      cycle: {
        ...wr.cycle,
        extras: wr.cycle.extras.filter((s) => s.id !== id),
        done: wr.cycle.done.filter((d) => d !== id),
        order: wr.cycle.order.filter((o) => o !== id),
      },
    };
    await saveWeeklyReview(userId, next);
    return buildState(userId);
  });

  /** Reorder — template order persists across reviews; extras stay cycle-local. */
  app.put("/review/steps/order", async (req) => {
    const userId = requireUser(req);
    const { ids } = z.object({ ids: z.array(z.string()).max(300) }).parse(req.body);
    const { wr } = await loadState(userId);
    await saveWeeklyReview(userId, reorderReviewSteps(wr, ids));
    return buildState(userId);
  });

  /** Check / uncheck a step for the current cycle. */
  app.post("/review/steps/:id/done", async (req) => {
    const userId = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { done } = z.object({ done: z.boolean() }).parse(req.body);
    const { wr } = await loadState(userId);
    const set = new Set(wr.cycle.done);
    if (done) set.add(id);
    else set.delete(id);
    await saveWeeklyReview(userId, { ...wr, cycle: { ...wr.cycle, done: [...set] } });
    return buildState(userId);
  });
}
