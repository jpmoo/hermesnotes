import { inlineMentions, profilesOf, type FieldDef, type PropertySchema } from "@hermes/shared";
import { CARRY_KEY } from "./import.js";
import type { Finding, HermesBlock, HermesMembership, HermesType } from "./types.js";

/**
 * Hermes, as pkm-interchange sees it.
 *
 * Read-only and pure: rows in, envelope out, plus a list of everything the
 * format could not be told. The findings are the point. An exporter that
 * silently drops what it cannot express produces a clean-looking file and
 * teaches nobody anything, which is the failure the format spends most of its
 * rules preventing — so this one keeps a tally instead.
 */

/** Hermes field types against the format's value kinds. */
const KIND: Record<string, string> = {
  text: "text",
  longtext: "richtext",
  date: "date",
  datetime: "datetime",
  datespan: "datespan",
  number: "number",
  boolean: "boolean",
  select: "enum",
  status: "enum",
  url: "url",
  reference: "reference",
  attachments: "attachment",
  // `recurrence` has no counterpart, deliberately: the format holds recurrence
  // as a series rather than as a value. See the findings.
};

export interface ExportInput {
  types: HermesType[];
  blocks: HermesBlock[];
  memberships: HermesMembership[];
  producer?: { name: string; version: string };
  /** Unknown top-level keys a previous import could not model. */
  carry?: Record<string, unknown>;
  /** Series that arrived from elsewhere. Hermes derives none of its own. */
  series?: unknown[];
  /** Edges that arrived and cannot be re-derived from properties or prose. */
  relations?: unknown[];
}

export function toInterchange(input: ExportInput): {
  envelope: Record<string, unknown>;
  findings: Finding[];
} {
  const found = new Map<string, Finding>();
  const note = (code: string, owner: Finding["owner"], detail: string) => {
    const at = found.get(code);
    if (at) at.count += 1;
    else found.set(code, { code, owner, detail, count: 1 });
  };

  const typeById = new Map(input.types.map((t) => [t.id, t]));
  const blockById = new Map(input.blocks.map((b) => [b.id, b]));
  const live = input.blocks.filter((b) => !b.collectionKind);
  const collections = input.blocks.filter((b) => b.collectionKind);

  // ---- types -------------------------------------------------------------
  const types = input.types.map((t) => {
    const schema = t.propertySchema;
    const fields = (schema?.fields ?? []).flatMap((f) => mapField(f, note));
    const declared = profilesOf(schema, { isText: t.isText });
    const profiles: Record<string, unknown> = {};
    for (const p of declared) {
      profiles[p.name] = p.map;
      if (p.derived) {
        note(
          "profile.derived-not-declared",
          "hermes",
          `${t.name}'s ${p.name} profile was worked out from status_field rather than declared. Correct, but a guess this export presents as a statement.`,
        );
      }
    }
    return {
      id: t.id,
      name: t.name,
      fields,
      profiles,
      // Not a format field. Kept because a consumer round-tripping this back
      // needs to know a text type's body lives outside `properties`.
      ...(t.isText ? { hermesTextType: true } : {}),
    };
  });

  // ---- objects -----------------------------------------------------------
  const objects = live.map((b) => {
    const schema = b.blockTypeId ? typeById.get(b.blockTypeId)?.propertySchema : null;
    for (const f of schema?.fields ?? []) {
      const v = b.properties[f.key];
      if (f.type === "datespan" && v && typeof v === "object") {
        const span = v as { start?: unknown; end?: unknown };
        if (span.start === "" || span.end === "") {
          note(
            "datespan.empty-string-end",
            "hermes",
            'A datespan end is stored as "" rather than being absent. The format now says an empty string is not a value and consumers must read it as omitted, so nothing is lost — but Hermes is writing a value where it means nothing, and the two shapes will keep meeting each other.',
          );
        }
      }
      // Declared `many` above, so a scalar here is Hermes storing one field two
      // ways rather than anything the format cannot express.
      if (f.type === "reference" && v !== undefined && v !== null && v !== "" && !Array.isArray(v)) {
        note(
          "reference.scalar-in-a-many-field",
          "hermes",
          "A reference field holds a bare id where every other value of the same field holds a list. The export declares the field `many`, so this one contradicts its own type.",
        );
      }
      if (f.type === "recurrence" && v) {
        note(
          "series.no-identity",
          "hermes",
          "A recurrence rule is stored on the block. The format holds recurrence as a series with instances pointing at it, and Hermes has no series identity to export — so this rule travels as an opaque property and the occurrences travel as unrelated objects.",
        );
      }
    }
    // What an import had nowhere to put rode along in the property bag. It comes
    // back out as the keys it arrived as and leaves no trace in the properties —
    // handing somebody their own data back with our filing label still on it is
    // not a round trip, it is littering.
    const carried = (b.properties[CARRY_KEY] ?? {}) as Record<string, unknown>;
    const props = { ...b.properties };
    delete props[CARRY_KEY];

    return {
      id: b.id,
      ...(b.blockTypeId ? { type: b.blockTypeId } : {}),
      ...carried,
      properties: props,
      ...(b.content ? { content: b.content } : {}),
      ...(b.tags?.length ? { tags: b.tags } : {}),
      archived: b.archivedAt !== null,
      created: b.createdAt,
      updated: b.updatedAt,
    };
  });

  // ---- collections -------------------------------------------------------
  const byCollection = new Map<string, HermesMembership[]>();
  for (const m of input.memberships) {
    byCollection.set(m.collectionId, [...(byCollection.get(m.collectionId) ?? []), m]);
  }

  const outCollections = collections.map((c) => {
    const props = c.properties;
    const kind = c.collectionKind!;
    const regions = Array.isArray(props.matrix_regions)
      ? (props.matrix_regions as { title?: string; tag?: string; tagOnEnter?: boolean }[])
      : [];
    const gridded = regions.length > 0;
    // A region's index means nothing outside the grid that produced it — the
    // same objection the format makes to coordinates, one step less obvious.
    const regionNames = regions.map((r, i) => slug(r.title) || `region-${i}`);
    if (gridded && regions.some((r) => !r.title?.trim())) {
      note(
        "placement.unnamed-region",
        "hermes",
        "A matrix region has no title, so it has no name to travel under and had to be exported as its index — which is exactly what the format forbids, for the same reason.",
      );
    }
    if (gridded && regions.every((r) => r.tagOnEnter)) {
      note(
        "placement.semantic-is-per-region",
        "format",
        "Every region on this board writes a tag onto whatever enters it, so the placement is copied onto the objects as well as held by the board. `placement.semantic` is one flag for a whole collection, and this is a per-region question — a board can mix regions that externalise their meaning with regions that keep it.",
      );
    }

    const smart = props.membership_mode === "smart";
    const members = (byCollection.get(c.id) ?? []).map((m) => {
      const ctx = m.context ?? {};
      const idx = ctx.region;
      const region =
        gridded && Number.isInteger(Number(idx)) && Number(idx) >= 0 && Number(idx) < regionNames.length
          ? regionNames[Number(idx)]
          : undefined;
      const rest = { ...ctx };
      delete (rest as Record<string, unknown>).region;
      return {
        object: m.blockId,
        ...(region ? { region } : {}),
        ...(m.position ? { position: m.position } : {}),
        ...(Object.keys(rest).length && !gridded ? { context: rest } : {}),
      };
    });

    // Everything else the collection carries — a canvas's notes and edges, a
    // table's columns, a rollup's levels, saved view state — travels untouched.
    // Naming five keys and dropping the rest is precisely the failure the
    // round-trip rule exists to stop, and an exporter is the easiest place in
    // the world to commit it without noticing.
    const carried = { ...props };
    for (const k of ["title", "matrix_regions", "membership_mode", "filter_query"]) delete carried[k];

    return {
      id: c.id,
      name: String(props.title ?? "Untitled"),
      kind,
      ...(Object.keys(carried).length ? { properties: carried } : {}),
      placement: gridded ? { semantic: true, regions: regionNames } : { semantic: false },
      membership: smart
        ? { mode: "query", materialized: false, query: props.filter_query ?? null }
        : { mode: "explicit" },
      members,
    };
  });

  // ---- relations ---------------------------------------------------------
  const relations: Record<string, unknown>[] = [];
  const titleToId = new Map<string, string>();
  for (const b of live) {
    const t = typeof b.properties.title === "string" ? b.properties.title.trim().toLowerCase() : "";
    if (t) titleToId.set(t, b.id);
  }
  for (const b of input.blocks) {
    const schema = b.blockTypeId ? typeById.get(b.blockTypeId)?.propertySchema : null;
    const bodyField = (schema?.fields ?? []).find((f) => f.type === "longtext")?.key ?? "content";
    const { ids, names } = inlineMentions(b.properties, b.content, b.id);
    for (const to of ids) {
      if (!blockById.has(to)) continue; // a link needs a far end that exists
      relations.push({ from: b.id, to, type: "mentions", via: "inline", field: bodyField });
    }
    for (const name of names) {
      const to = titleToId.get(name);
      if (to) {
        relations.push({ from: b.id, to, type: "mentions", via: "inline", field: bodyField });
      } else {
        // The stub case, and Hermes has no stubs: the name lives in the prose
        // and resolves to nothing, so there is no far end to point at and no
        // object to carry the name. The mention cannot be exported at all.
        note(
          "relation.name-without-a-thing",
          "hermes",
          `An @mention names "${name}", which resolves to nothing. A link needs a far end, and Hermes has no stub object to be that end, so this edge cannot be exported and the reader of this file will not know the sentence points anywhere.`,
        );
      }
    }
    // A canvas holds two things the format has no object for: notes that are not
    // blocks, and the connections drawn between them. Both are somebody's
    // thinking, arranged on purpose, and neither has an id anyone else could
    // address — so a whole canvas can come through this exporter looking empty.
    const stickies = Array.isArray(b.properties.canvas_notes) ? b.properties.canvas_notes : [];
    if (stickies.length) {
      note(
        "canvas.stickies-are-not-addressable",
        "format",
        `A canvas holds ${stickies.length} note(s) that are not blocks. They survive — they are properties of the collection and the round-trip rule carries them — but they have no id anyone outside this producer can address, so nothing can link to one and the connections between them cannot be stated as relations. A canvas of drawn argument arrives as an opaque lump.`,
      );
    }

    // Canvas edges are drawn, not written.
    const edges = Array.isArray(b.properties.canvas_edges) ? b.properties.canvas_edges : [];
    for (const e of edges as { from?: string; to?: string; label?: string; live?: boolean }[]) {
      if (e.live === false || !e.from || !e.to) continue;
      if (e.from.startsWith("n:") || e.to.startsWith("n:")) {
        note(
          "relation.edge-to-a-sticky",
          "format",
          "A canvas connects a block to a sticky note that is not a block and has no id of its own. The format has no object for it, so the edge is dropped — one end of it does not exist as far as anyone else is concerned.",
        );
        continue;
      }
      if (!blockById.has(e.from) || !blockById.has(e.to)) continue;
      relations.push({ from: e.from, to: e.to, type: e.label || "connected", via: "edge" });
    }
  }

  // Declared because the types plainly use it — a consumer meeting a field of
  // kind `attachment` has to cope with it, whatever we do about the bytes.
  const hasAttachments = types.some((t) => t.fields.some((f) => f.kind === "attachment"));
  if (hasAttachments) {
    note(
      "attachments.contents-do-not-travel",
      "format",
      "A type declares an attachment field, and the format has no story for the bytes behind one — no encoding, no side-car, no reference to fetch it by. The field travels and the file it stands for does not, which is worse than either declaring the feature honestly or leaving it out.",
    );
  }

  const findings = [...found.values()].sort((a, b) => b.count - a.count);
  const features = [
    hasAttachments ? "attachments" : null,
    outCollections.some((c) => c.placement.semantic) ? "placement" : null,
    outCollections.some((c) => c.membership.mode === "query") ? "derivations" : null,
    relations.length ? "relations" : null,
  ].filter(Boolean) as string[];

  // An edge that arrived from elsewhere and one Hermes worked out for itself are
  // the same edge; saying it twice is not fidelity, it is duplication.
  const key = (r: Record<string, unknown>) => `${r.from}|${r.to}|${r.type ?? ""}|${r.via ?? ""}`;
  const seen = new Set(relations.map(key));
  for (const r of (input.relations ?? []) as Record<string, unknown>[]) {
    if (!seen.has(key(r))) {
      relations.push(r);
      seen.add(key(r));
    }
  }

  return {
    envelope: {
      format: "pkm-interchange/0",
      producer: { ...(input.producer ?? { name: "hermes", version: "0.0.0" }), stableIds: true },
      conformance: {
        produce: 2,
        consume: 0,
        operate: 0,
        bindings: ["file"],
        profiles: [...new Set(types.flatMap((t) => Object.keys(t.profiles)))],
        features,
        // Recurrence is the honest one: Hermes plainly has it and cannot say so
        // here, because the format wants a series and Hermes has no series.
        unsupported: ["series"],
      },
      types,
      objects,
      collections: outCollections,
      ...((input.series ?? []).length ? { series: input.series } : {}),
      relations,
      ...(input.carry ?? {}),
    },
    findings,
  };
}

const FIELD_KEYS = new Set([
  "key", "type", "label", "order", "includeEmbed", "options", "optionLabels", "optionIcons", "optionColors",
  "refTypeId", "templateId", "startLabel", "endLabel", "units", "required", "locked",
]);

function mapField(f: FieldDef, note: (c: string, o: Finding["owner"], d: string) => void) {
  // The list of kinds is open, so a kind the format has never heard of is
  // declared under its own name rather than dropped. `recurrence` is the one
  // that matters here, and it travels opaque because the format wants recurrence
  // as a series — which is the series.no-identity finding, not this one.
  const kind = KIND[f.type] ?? f.type;
  return [
    {
      key: f.key,
      kind,
      ...(f.label ? { label: f.label } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.options ? { options: f.options } : {}),
      ...(f.optionLabels ? { optionLabels: f.optionLabels } : {}),
      ...(f.refTypeId ? { targetType: f.refTypeId } : {}),
      // Hermes reference fields hold a list, always — 62 of 62 values in a real
      // library — so this is a declaration rather than an observation.
      ...(f.type === "reference" ? { many: true } : {}),
      ...(f.units ? { units: f.units } : {}),
      ...(f.startLabel ? { startLabel: f.startLabel } : {}),
      ...(f.endLabel ? { endLabel: f.endLabel } : {}),
      // Anything a producer hung on this field that Hermes does not model.
      ...Object.fromEntries(Object.entries(f).filter(([k]) => !FIELD_KEYS.has(k))),
    },
  ];
}

/** A region title as a name that survives being read somewhere with no grid. */
const slug = (s: string | undefined) =>
  (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export type { Finding } from "./types.js";
