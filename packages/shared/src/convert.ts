import { bodyFieldKey, profilesOf, type FieldDef, type PropertySchema } from "./property-schema.js";

/**
 * Turning a block into a different type.
 *
 * In place, keeping the id. That is not an implementation detail, it is most of
 * the value: tags, attachments, collection membership and every inbound
 * `[Label](block:<id>)` link hang off the id and survive untouched. Making a new
 * block and copying the words across loses all four, silently, and the links are
 * the ones nobody notices until much later.
 *
 * What is at risk is the property bag, and this file is about deciding — and
 * then *saying* — what carries and what does not.
 *
 * **Never by type name.** `if (type.name === "Task")` is a bug here as
 * everywhere: a type is a row the user can rename, and this repository has
 * already been bitten once by a lookup that matched `text` against a type called
 * `Text`. Fields are matched by key, by declared profile, and by shape.
 */

/** A field's value moving from one type to another, or failing to. */
export interface Carried {
  /** Field key on the source type. */
  from: string;
  /** Field key on the target type. */
  to: string;
  /** Human-readable, for a confirmation somebody has to act on. */
  fromLabel: string;
  toLabel: string;
  /** Why these two were matched — shown, because a guess should say it guessed. */
  how: "key" | "profile" | "shape" | "body";
  value: unknown;
}

export interface Lost {
  key: string;
  label: string;
  /** Rendered value, so a confirmation can show what is about to go. */
  shown: string;
}

export interface Conversion {
  properties: Record<string, unknown>;
  /** Body for a text target; null when the target keeps its body in a field. */
  content: string | null;
  carried: Carried[];
  lost: Lost[];
}

const labelOf = (f: FieldDef): string =>
  f.label?.trim() ||
  f.key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const isBlank = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** What a value looks like when somebody has to decide whether to lose it. */
export function shownValue(f: FieldDef, v: unknown): string {
  if (isBlank(v)) return "";
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (f.type === "datespan") {
      const a = typeof o.start === "string" ? o.start : "";
      const b = typeof o.end === "string" ? o.end : "";
      return a && b ? `${a} → ${b}` : a || b || "set";
    }
    return "set";
  }
  return String(v);
}

/**
 * Which target field a source field can become.
 *
 * Three ways, tried in order, and each is narrower than it looks on purpose —
 * a wrong match writes somebody's meeting time into a duration.
 *
 *  1. **The same key**, when the kinds agree. `title` is `title` everywhere in
 *     this app and carrying it is never a guess.
 *  2. **The same profile slot**, when both types declare one. This is the
 *     vocabulary the interchange format exists for, and where it is present it
 *     is the best evidence there is.
 *  3. **The only field of that shape.** A source with exactly one datespan and a
 *     target with exactly one datespan can only mean one thing. This is what
 *     actually carries an Event's "When" into a Task's "Schedule" — start to
 *     Available, end to Due — because neither type declares a profile, which is
 *     the ordinary case rather than the exception.
 *
 * Ambiguity is never resolved by guessing. Two datespans on either side and the
 * shape rule declines, the field is reported lost, and somebody moves it by
 * hand knowing they did.
 */
function matchField(
  f: FieldDef,
  from: PropertySchema | null | undefined,
  to: PropertySchema | null | undefined,
): { field: FieldDef; how: Carried["how"] } | null {
  const targets = to?.fields ?? [];
  const compatible = (a: FieldDef, b: FieldDef) => a.type === b.type;

  const byKey = targets.find((t) => t.key === f.key && compatible(f, t));
  if (byKey) return { field: byKey, how: "key" };

  // Profile slots, where both sides have said what they are.
  for (const p of profilesOf(from)) {
    const q = profilesOf(to).find((x) => x.name === p.name);
    if (!q) continue;
    for (const [slot, spec] of Object.entries(p.map)) {
      const srcKey = typeof spec === "string" ? spec : (spec as { field?: string })?.field;
      if (srcKey !== f.key) continue;
      const tgt = q.map[slot];
      const tgtKey = typeof tgt === "string" ? tgt : (tgt as { field?: string })?.field;
      const found = targets.find((t) => t.key === tgtKey && compatible(f, t));
      if (found) return { field: found, how: "profile" };
    }
  }

  const sourcesOfKind = (from?.fields ?? []).filter((x) => x.type === f.type);
  const targetsOfKind = targets.filter((t) => t.type === f.type);
  if (sourcesOfKind.length === 1 && targetsOfKind.length === 1) {
    return { field: targetsOfKind[0]!, how: "shape" };
  }
  return null;
}

/**
 * Work out the whole conversion without performing any of it.
 *
 * Called twice with the same arguments: once to show somebody what will happen,
 * once to do it. The confirmation and the write must not be able to disagree,
 * which they would the moment either grew its own copy of these rules.
 */
export function planConversion(
  block: { content: string | null; properties: Record<string, unknown> },
  from: { isText: boolean; schema: PropertySchema | null | undefined },
  to: { isText: boolean; schema: PropertySchema | null | undefined },
): Conversion {
  const carried: Carried[] = [];
  const lost: Lost[] = [];
  const props: Record<string, unknown> = {};

  // A text block keeps everything in `content`; a typed one keeps a title and
  // named fields. Crossing that line is the only part of this that is not a
  // field-to-field move.
  const sourceBody = from.isText
    ? (block.content ?? "")
    : String(block.properties[bodyFieldKey(from.schema) ?? ""] ?? "");
  const sourceTitle = from.isText
    ? (block.content ?? "").split("\n")[0]?.trim() ?? ""
    : String(block.properties.title ?? "");

  if (to.isText) {
    // Everything the target cannot name is reported, not smuggled into the body:
    // a Task's status quietly appended as a line of prose is worse than losing
    // it, because it looks like something somebody wrote.
    for (const f of from.schema?.fields ?? []) {
      if (f.key === "title" || f.key === bodyFieldKey(from.schema)) continue;
      const v = block.properties[f.key];
      if (isBlank(v)) continue;
      lost.push({ key: f.key, label: labelOf(f), shown: shownValue(f, v) });
    }
    const body = from.isText
      ? (block.content ?? "")
      : [sourceTitle, sourceBody].filter((s) => s.trim()).join("\n\n");
    return { properties: {}, content: body, carried, lost };
  }

  // Target is typed. Its title is the source's title, or a text block's first
  // line — which is what a text block's title has always been.
  if (sourceTitle) {
    props.title = sourceTitle;
    const t = (to.schema?.fields ?? []).find((f) => f.key === "title");
    carried.push({
      from: "title",
      to: "title",
      fromLabel: from.isText ? "First line" : "Title",
      toLabel: t ? labelOf(t) : "Title",
      how: from.isText ? "body" : "key",
      value: sourceTitle,
    });
  }

  const targetBodyKey = bodyFieldKey(to.schema);
  if (from.isText) {
    // The rest of the note becomes the target's body field. Losing it would be
    // losing the note, so a target with nowhere to put it says so loudly.
    const rest = (block.content ?? "").split("\n").slice(1).join("\n").trim();
    if (rest) {
      if (targetBodyKey) {
        props[targetBodyKey] = rest;
        const t = (to.schema?.fields ?? []).find((f) => f.key === targetBodyKey);
        carried.push({
          from: "content",
          to: targetBodyKey,
          fromLabel: "Body",
          toLabel: t ? labelOf(t) : targetBodyKey,
          how: "body",
          value: rest,
        });
      } else {
        lost.push({ key: "content", label: "Body", shown: shownValue({ key: "content", type: "longtext", order: 0, includeEmbed: false }, rest) });
      }
    }
    return { properties: props, content: null, carried, lost };
  }

  for (const f of from.schema?.fields ?? []) {
    if (f.key === "title") continue;
    const v = block.properties[f.key];
    if (isBlank(v)) continue;
    const m = matchField(f, from.schema, to.schema);
    if (!m) {
      lost.push({ key: f.key, label: labelOf(f), shown: shownValue(f, v) });
      continue;
    }
    // A select or status whose value the target does not offer would be an
    // option nothing can render and no filter can find.
    if ((m.field.type === "select" || m.field.type === "status") && typeof v === "string") {
      if (!(m.field.options ?? []).includes(v)) {
        lost.push({ key: f.key, label: labelOf(f), shown: shownValue(f, v) });
        continue;
      }
    }
    props[m.field.key] = v;
    carried.push({
      from: f.key,
      to: m.field.key,
      fromLabel: labelOf(f),
      toLabel: labelOf(m.field),
      how: m.how,
      value: v,
    });
  }
  return { properties: props, content: null, carried, lost };
}
