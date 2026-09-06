/**
 * What the machine noticed while nobody was asking.
 *
 * `AMBIENT.md`'s fifth capability: "a box with idle capacity changes what the AI
 * is *for*. Not 'ask a question, get an answer' — continuous, low-stakes
 * proposal generation." Which daily-note lines want to be tasks. Which stubs are
 * duplicates. Which tasks have quietly gone stale.
 *
 * Three rules hold it together, and each one is the difference between this and
 * a nuisance:
 *
 * **Never written.** Every proposal is a row in a queue somebody reads. Acting
 * on one is a person's job, in Hermes, through the paths that already exist. An
 * agent that filed its own suggestions would be an agent editing a library while
 * its owner was asleep.
 *
 * **Rules before the model.** Most of what is worth noticing is arithmetic — a
 * task whose date went by, two blocks with the same title — and arithmetic is
 * cheap, deterministic, always available, and explainable in one sentence. The
 * model is for the judgments arithmetic cannot make, and it runs only when one
 * is configured and the budget allows.
 *
 * **A budget and a decay**, because the document asks for both and says why: "an
 * unbounded proposal generator produces noise, and a review queue people stop
 * opening is worse than no queue."
 */

import { randomUUID } from "node:crypto";
import type { CanonicalBlock } from "@talaria/canonical";
import type { Mirror } from "./mirror.js";

/** How many may be waiting at once. Past this, the run does nothing. */
export const CEILING = 40;
/** How many a single run may add, so one night cannot fill the queue. */
export const PER_RUN = 8;
/** A task untouched for this long, already due, is worth mentioning once. */
const STALE_DAYS = 21;
/** Unread proposals decay; dismissals are remembered far longer. */
export const STALE_AFTER_DAYS = 14;
export const FORGET_DISMISSED_AFTER_DAYS = 180;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * The arithmetic ones.
 *
 * Deliberately conservative. Each of these can be explained to somebody in a
 * sentence, and a proposal nobody can explain is one nobody trusts.
 */
export function byRule(rows: CanonicalBlock[]): Omit<
  Parameters<Mirror["proposeOne"]>[0],
  "id"
>[] {
  const out: Omit<Parameters<Mirror["proposeOne"]>[0], "id">[] = [];
  const today = day(0);
  const stale = day(-STALE_DAYS);

  for (const b of rows) {
    if (b.archivedAt) continue;

    // A task that was due, is not done, and has not been touched since.
    const due = b.schedule?.end?.value;
    if (
      b.completable &&
      b.completion?.done !== true &&
      typeof due === "string" &&
      due.slice(0, 10) < today &&
      (b.updatedAt ?? "").slice(0, 10) < stale
    ) {
      out.push({
        fingerprint: `stale:${b.id}:${due.slice(0, 10)}`,
        kind: "stale",
        about: b.id,
        title: b.title,
        detail: `Due ${due.slice(0, 10)}, not done, and untouched since ${(b.updatedAt ?? "").slice(0, 10)}.`,
        source: "rules",
      });
    }
  }

  /*
   * Two blocks wearing the same name.
   *
   * Not "duplicates" — that is a judgment. Two things with one title is a fact,
   * and it is nearly always either a duplicate or a name that needs to be more
   * specific. Either way it is worth a look, and saying only what is true keeps
   * the queue trustworthy.
   */
  const byTitle = new Map<string, CanonicalBlock[]>();
  for (const b of rows) {
    const key = (b.title ?? "").trim().toLowerCase();
    if (!key || b.archivedAt) continue;
    // A daily note is the same title every day by design.
    if (/scratchpad|daily note|\d{4}-\d{2}-\d{2}/.test(key)) continue;
    (byTitle.get(key) ?? byTitle.set(key, []).get(key)!).push(b);
  }
  for (const [, same] of byTitle) {
    if (same.length < 2) continue;
    const ids = same.map((b) => b.id).sort();
    out.push({
      fingerprint: `sametitle:${ids.join(",")}`,
      kind: "same-title",
      about: ids[0] ?? null,
      title: same[0]?.title ?? null,
      detail: `${same.length} blocks share this title.`,
      source: "rules",
    });
  }

  return out;
}

/**
 * The judgments, which need a model.
 *
 * One question, asked of today's and yesterday's notes: which lines are things
 * somebody meant to do? A daily note is where that happens — it is where people
 * write "ring the roofer" in the middle of a paragraph about something else —
 * and it is the one judgment here that arithmetic genuinely cannot make.
 *
 * Answered as JSON and read defensively: a local model that returns prose
 * instead of a list is a run that proposes nothing, not a crash.
 */
export async function byModel(
  rows: CanonicalBlock[],
  opts: { url: string; model: string; signal?: AbortSignal },
): Promise<Omit<Parameters<Mirror["proposeOne"]>[0], "id">[]> {
  const recent = rows
    .filter((b) => (b.body ?? "").trim() && (b.updatedAt ?? "") >= day(-2))
    .slice(0, 4);
  if (!recent.length) return [];

  const out: Omit<Parameters<Mirror["proposeOne"]>[0], "id">[] = [];
  for (const note of recent) {
    const prompt = [
      "Below are lines from somebody's notes. Some of them are things they meant to do.",
      "Return JSON only: an array of the exact lines that read as an intention to do something.",
      'Format: {"lines": ["…", "…"]}. Return {"lines": []} if none are.',
      "Do not invent lines. Do not rewrite them. Copy them exactly.",
      "",
      (note.body ?? "").slice(0, 4000),
    ].join("\n");

    let said = "";
    try {
      const res = await fetch(`${opts.url.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          format: "json",
        }),
        signal: opts.signal,
      });
      if (!res.ok) continue;
      said = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
    } catch {
      // A model that is not there is not an error worth stopping a run for; the
      // rules above have already done their half.
      continue;
    }

    let lines: unknown;
    try {
      lines = (JSON.parse(said) as { lines?: unknown }).lines;
    } catch {
      continue;
    }
    if (!Array.isArray(lines)) continue;

    for (const line of lines.slice(0, 4)) {
      const text = String(line ?? "").trim();
      // Only lines that are actually in the note. A proposal about a sentence
      // nobody wrote is the failure mode that makes people stop reading these.
      if (!text || text.length < 4 || !(note.body ?? "").includes(text)) continue;
      out.push({
        fingerprint: `totask:${note.id}:${text.slice(0, 80)}`,
        kind: "to-task",
        about: note.id,
        title: text.slice(0, 200),
        detail: `Written in ${note.title ?? "a note"}. Looks like something to do.`,
        source: "model",
      });
    }
  }
  return out;
}

/**
 * One pass: notice things, keep what is new, forget what has decayed.
 *
 * Returns what it did, because a background job that says nothing is one nobody
 * can tell is running — and `doctor` should be able to say.
 */
export async function propose(
  mirror: Mirror,
  /**
   * How to read the mirror's rows as blocks.
   *
   * Handed in rather than built here: turning a stored row into a canonical
   * block needs the type index and the configured origin, and both of those
   * live where the server is assembled. This file is arithmetic and one prompt.
   */
  rowsOf: () => CanonicalBlock[],
  opts: { url?: string; model?: string; signal?: AbortSignal } = {},
): Promise<{ added: number; pruned: number; skipped: string | null }> {
  const pruned = mirror.pruneProposals(
    new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000).toISOString(),
    new Date(Date.now() - FORGET_DISMISSED_AFTER_DAYS * 86_400_000).toISOString(),
  );

  if (mirror.proposalCount() >= CEILING) {
    return { added: 0, pruned, skipped: "the queue is already full" };
  }

  const rows = rowsOf();
  const found = [...byRule(rows)];
  if (opts.url && opts.model) {
    found.push(...(await byModel(rows, { url: opts.url, model: opts.model, signal: opts.signal })));
  }

  let added = 0;
  for (const p of found) {
    if (added >= PER_RUN) break;
    if (mirror.proposeOne({ id: randomUUID(), ...p })) added += 1;
  }
  return { added, pruned, skipped: null };
}
