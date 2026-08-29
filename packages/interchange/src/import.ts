import type { Finding, HermesBlock, HermesMembership, HermesType } from "./types.js";

/**
 * An envelope, read back into Hermes rows.
 *
 * The inverse of `toInterchange`, and the harder direction. Exporting only has
 * to find a way to say what you hold; importing has to find somewhere to put
 * what you don't. Everything a producer sent that Hermes has no column for is
 * kept rather than dropped — that is the whole of level 2, and it is what makes
 * a tool a waypoint instead of a terminus.
 */

/** Where an object's unmappable parts are kept, so a re-export can put them back. */
/**
 * The format's sort vocabulary in Hermes' spelling — the inverse of the
 * exporter's `sortKeyOf`, and kind-aware because Hermes is.
 *
 * A list spells "by title" `alpha`; a table spells it `prop:title`, because a
 * table sorts on its columns and its column list excludes the title. Mapping
 * both to one spelling would round-trip one of them into the other, which is a
 * silent change to somebody's saved view.
 */
export function hermesSortKey(by: { field?: string; part?: string; meta?: string }, kind: string): string | null {
  if (by.meta === "created") return "created";
  if (by.meta === "updated") return "edited";
  if (by.meta === "type") return "type";
  if (by.meta) return null;
  if (typeof by.field !== "string" || !by.field) return null;
  if (by.field === "title" && !by.part && kind !== "table") return "alpha";
  return `prop:${by.field}${by.part ? `.${by.part}` : ""}`;
}

export const CARRY_KEY = "pkm:carried";

/** Format value kinds against Hermes field types. */
const TYPE: Record<string, string> = {
  text: "text",
  richtext: "longtext",
  date: "date",
  datetime: "datetime",
  datespan: "datespan",
  number: "number",
  boolean: "boolean",
  enum: "select",
  url: "url",
  reference: "reference",
  attachment: "attachments",
};

// `version` is here because it is a real field, not an annotation. Left out, it
// arrived as something Hermes had no column for, rode back out in the carried
// bag, and landed in a different place in the object — nothing lost, and a
// round-trip diff of 1621 lines saying so.
const OBJECT_KEYS = new Set([
  "id", "type", "properties", "content", "tags", "archived", "created", "updated", "version",
]);
const ENVELOPE_KEYS = new Set([
  "format", "producer", "conformance", "types", "objects", "collections", "series", "relations",
]);

export interface ImportResult {
  types: HermesType[];
  blocks: HermesBlock[];
  memberships: HermesMembership[];
  /**
   * What had nowhere to go: series definitions, relations Hermes derives rather
   * than stores, unknown top-level keys.
   *
   * Returned rather than written, because Hermes has no table for it. That is
   * the honest cost of level 2 and the finding says so — an importer that
   * silently discarded this would round-trip cleanly right up until somebody
   * checked.
   */
  carry: Record<string, unknown>;
  /** Series and relations as they arrived: known to the format, unstorable here. */
  series: unknown[];
  relations: unknown[];
  findings: Finding[];
}

export function fromInterchange(envelope: Record<string, unknown>): ImportResult {
  const found = new Map<string, Finding>();
  const note = (code: string, owner: Finding["owner"], detail: string) => {
    const at = found.get(code);
    if (at) at.count += 1;
    else found.set(code, { code, owner, detail, count: 1 });
  };

  const inTypes = (envelope.types ?? []) as Record<string, unknown>[];
  const inObjects = (envelope.objects ?? []) as Record<string, unknown>[];
  const inCollections = (envelope.collections ?? []) as Record<string, unknown>[];

  const types: HermesType[] = inTypes.map((t) => {
    const fields = ((t.fields ?? []) as Record<string, unknown>[]).map((f, i) => {
      const kind = String(f.kind ?? "text");
      const mapped = TYPE[kind];
      if (!mapped) {
        // The kind list is open, so this is a producer being legitimate rather
        // than a producer being wrong. Hermes stores the field under the name it
        // arrived with; its values are readable, its editor is not.
        note(
          "field.kind-hermes-cannot-edit",
          "hermes",
          `A field of kind "${kind}" has no Hermes field type, so it is stored under the name it came with. Its values survive and read back out; nothing in the app knows how to edit it.`,
        );
      }
      // Whatever else the field carried. A producer's own annotations on their
      // own schema are exactly the kind of thing the round-trip rule is about,
      // and a mapping table that names nine keys drops the tenth by omission.
      const known = new Set([
        "key", "kind", "label", "required", "options", "targetType", "units", "startLabel", "endLabel", "many",
      ]);
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f)) if (!known.has(k)) extra[k] = v;

      return {
        key: String(f.key),
        type: (mapped ?? kind) as never,
        order: i,
        includeEmbed: false,
        ...extra,
        ...(f.label ? { label: String(f.label) } : {}),
        ...(f.required ? { required: true } : {}),
        ...(f.options ? { options: f.options as string[] } : {}),
        ...(f.targetType ? { refTypeId: String(f.targetType) } : {}),
        ...(f.units ? { units: String(f.units) } : {}),
        ...(f.startLabel ? { startLabel: String(f.startLabel) } : {}),
        ...(f.endLabel ? { endLabel: String(f.endLabel) } : {}),
      };
    });

    // A declared task profile is where Hermes reads completion from, and the
    // schema keeps its own copy of the same answer so every existing surface
    // keeps working without being taught the vocabulary.
    const task = (t.profiles as Record<string, Record<string, unknown>> | undefined)?.task;
    const status = typeof task?.status === "string" ? task.status : null;
    const complete = Array.isArray(task?.completeValues) ? (task.completeValues as string[]) : undefined;

    return {
      id: String(t.id),
      name: String(t.name ?? "Untitled"),
      isText: t.hermesTextType === true,
      propertySchema: {
        fields,
        ...(t.profiles ? { profiles: t.profiles as Record<string, Record<string, unknown>> } : {}),
        ...(status ? { status_field: status } : {}),
        ...(complete ? { complete_values: complete } : {}),
      } as HermesType["propertySchema"],
    };
  });

  const blocks: HermesBlock[] = inObjects.map((o) => {
    // Anything the object carried that Hermes has no column for rides along in
    // the property bag. Stub flags, suggestions, whatever a later version of the
    // format adds — none of it is Hermes' to understand, and all of it is
    // Hermes' to give back.
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!OBJECT_KEYS.has(k)) extra[k] = v;
    if (Object.keys(extra).length) {
      note(
        "object.carried-not-modelled",
        "hermes",
        `An object arrived with ${Object.keys(extra).join(", ")}, which Hermes has no column for. It is kept in the property bag so a re-export can put it back, and nothing in the app will ever show it.`,
      );
    }
    return {
      id: String(o.id),
      blockTypeId: o.type ? String(o.type) : null,
      collectionKind: null,
      content: typeof o.content === "string" ? o.content : null,
      properties: {
        ...((o.properties ?? {}) as Record<string, unknown>),
        ...(Object.keys(extra).length ? { [CARRY_KEY]: extra } : {}),
      },
      archivedAt: o.archived === true ? new Date(0).toISOString() : null,
      createdAt: String(o.created ?? new Date(0).toISOString()),
      updatedAt: String(o.updated ?? new Date(0).toISOString()),
      ...(typeof o.version === "number" ? { version: o.version } : {}),
      tags: Array.isArray(o.tags) ? (o.tags as string[]) : [],
    };
  });

  const memberships: HermesMembership[] = [];
  for (const c of inCollections) {
    // A region is a name, or a name and the words a person reads. This cast
    // said `string[]` and `indexOf` matched against it, which was true until a
    // region grew a label — and then every card on a labelled board lost its
    // placement, `matrix_regions` was rebuilt with an object where a title
    // string belongs, and the export got blamed for it with a
    // `placement.region-not-declared` finding owned by `format`.
    //
    // The same cast, in the same shape, that Talaria found on its own side. It
    // survived here because no test library had a labelled region until one did.
    const placement = (c.placement ?? {}) as {
      semantic?: boolean;
      regions?: (string | Record<string, unknown>)[];
    };
    const declared = placement.regions ?? [];
    const names = declared.map((r) => (typeof r === "string" ? r : String(r.name ?? "")));
    // Back to Hermes' shape: the label is the title a person edits, the name is
    // what a member matches on, and the producer's own keys lose the prefix
    // they travelled under so they land where Hermes keeps them.
    const regionDefs = declared.map((r, i) => {
      if (typeof r === "string") return { title: r, tag: r };
      const { name: _n, label, ...rest } = r;
      const extra = Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [k.startsWith("hermes:") ? k.slice(7) : k, v]),
      );
      return { title: String(label ?? names[i] ?? ""), tag: names[i] ?? "", ...extra };
    });
    // The prefix comes back off, so these land where Hermes keeps them and a
    // round trip compares equal. Same move the regions above make, for the same
    // reason: a producer's own keys travel prefixed and are stored unprefixed.
    const carried = Object.fromEntries(
      Object.entries((c.properties ?? {}) as Record<string, unknown>).map(([k, v]) => [
        k.startsWith("hermes:") ? k.slice(7) : k,
        v,
      ]),
    );
    /**
     * The placements the collection's query no longer returns.
     *
     * A card dropped in "urgent-important" and since completed is not a member —
     * the query does not return it — so the export could not carry it as one and
     * put it under the producer's prefix instead. Taken off `carried` here
     * rather than read out later, because the block below spreads `carried` into
     * its properties and a key removed after that has already been copied.
     *
     * Restored as membership rows, because the alternative is that completing a
     * task silently forgets which quadrant somebody decided it belonged in, and
     * un-completing it puts the card back on the board with nowhere to go.
     */
    const unmatched = (carried.unmatched_placements ?? []) as Record<string, unknown>[];
    delete carried.unmatched_placements;
    // A collection's own top-level keys, which until now went nowhere.
    //
    // Objects have carried their unrecognised keys since level 2 was claimed;
    // collections never did, because every key the format had for one — `id`,
    // `name`, `kind`, `placement`, `membership`, `members` — was consumed just
    // above, so there was visibly nothing left over. `url` was the first key to
    // arrive that nothing here reads, and it vanished silently: the round-trip
    // rule broken not by mishandling a key but by there being no place where a
    // new one would land.
    //
    // That is the shape of the failure worth remembering — an exhaustive
    // handler is only exhaustive until the format grows.
    const COLLECTION_KEYS = new Set(["id", "name", "kind", "properties", "placement", "membership", "members", "order"]);
    const cExtra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) if (!COLLECTION_KEYS.has(k)) cExtra[k] = v;
    // `order` is open like every other object here, and consuming it is not a
    // licence to rebuild it from the two keys this understands. Whatever else a
    // producer wrote inside it — which headings are collapsed, whether one
    // sticks to the top — is kept whole and merged back on the way out.
    const orderRest = Object.fromEntries(
      Object.entries((c.order ?? {}) as Record<string, unknown>).filter(([k]) => k !== "sort" && k !== "groupBy"),
    );
    if (Object.keys(orderRest).length) cExtra.order = orderRest;
    const smart = (c.membership as { mode?: string } | undefined)?.mode === "query";

    /**
     * The arrangement, landed on whichever view of this kind holds one.
     *
     * Consumed rather than carried, because it is regenerated from Hermes' own
     * view state on the way out — leaving it in the carried bag as well would
     * mean two answers in the same export, free to disagree the moment somebody
     * changes the sort in the app.
     *
     * Absent `sort` is the format saying the stored order is the decision, so it
     * arrives as `manual: true` rather than as an empty sort list. The two are
     * not the same thing to the app: one pins the rows, the other sorts by
     * nothing and lets a re-render reorder them.
     */
    const kindName = String(c.kind ?? "list");
    const inOrder = (c.order ?? null) as {
      sort?: { by?: { field?: string; part?: string; meta?: string }; direction?: string }[];
      groupBy?: { field?: string; part?: string; meta?: string };
    } | null;
    const arrangement: Record<string, unknown> = {};
    if (inOrder) {
      const levels = (inOrder.sort ?? [])
        .map((l) => {
          const key = l.by ? hermesSortKey(l.by, kindName) : null;
          return key ? { key, dir: l.direction === "descending" ? "desc" : "asc" } : null;
        })
        .filter(Boolean);
      if ((inOrder.sort ?? []).length && levels.length < (inOrder.sort ?? []).length) {
        note(
          "order.sort-key-unmapped",
          "hermes",
          "A sort names a key Hermes has no spelling for, so that level was dropped and the collection arrives sorted by the levels that did map — which is a different order, not a missing feature.",
        );
      }
      if (levels.length) arrangement.sort = levels;
      arrangement.manual = (inOrder.sort ?? []).length === 0;
      const g = inOrder.groupBy ? hermesSortKey(inOrder.groupBy, kindName) : null;
      if (g && kindName !== "table") arrangement.groupBy = g;
      if (inOrder.groupBy && (!g || kindName === "table")) {
        note(
          "order.grouping-dropped",
          "hermes",
          `This collection is grouped and Hermes' ${kindName} view has nowhere to put grouping, so it arrives as a flat arrangement. The members are all here; the headings somebody organised them under are not.`,
        );
      }
    }
    // Which view of Hermes' own holds it, by kind — the same choice the exporter
    // makes in the other direction.
    const arranged: Record<string, unknown> = !Object.keys(arrangement).length
      ? {}
      : kindName === "table"
        ? { table_sort: arrangement.sort ?? [] }
        : kindName === "rollup"
          ? { rollup_views: { top: arrangement } }
          : { view_state: arrangement };

    blocks.push({
      id: String(c.id),
      blockTypeId: null,
      collectionKind: String(c.kind ?? "list"),
      content: null,
      properties: {
        ...carried,
        ...(Object.keys(cExtra).length ? { [CARRY_KEY]: cExtra } : {}),
        title: String(c.name ?? "Untitled"),
        ...(regionDefs.length ? { matrix_regions: regionDefs } : {}),
        ...arranged,
        membership_mode: smart ? "smart" : "explicit",
        // `materialized` had nowhere to land, so every imported query came back
        // as a live one. Harmless until the exporter started asking — a
        // materialized query's members *are* the truth, and reading it as
        // dynamic meant re-exporting it looked for an answer nobody had computed
        // and shipped an empty collection where somebody had deliberately frozen
        // a set.
        ...(smart
          ? {
              filter_query: (c.membership as { query?: unknown }).query ?? null,
              smart_mode: (c.membership as { materialized?: boolean }).materialized ? "snapshot" : "dynamic",
            }
          : {}),
      },
      archivedAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      tags: [],
    });

    for (const m of [...((c.members ?? []) as Record<string, unknown>[]), ...unmatched]) {
      const region = typeof m.region === "string" ? names.indexOf(m.region) : -1;
      // Only a *semantic* region is a judgment somebody made and a placement
      // that has to land somewhere. On a board whose columns are drawn from a
      // status field the objects already carry, the region is a rendering of
      // data held elsewhere: dropping it loses nothing, and reporting it would
      // teach a reader to ignore the report that matters.
      if (placement.semantic === true && typeof m.region === "string" && region < 0) {
        note(
          "placement.region-not-declared",
          "format",
          `A member sits in region "${String(m.region)}", which the collection's own region list does not contain. There is nowhere to put it, and a board that names a place it has not declared cannot be drawn.`,
        );
      }
      memberships.push({
        collectionId: String(c.id),
        blockId: String(m.object ?? m),
        position: typeof m.position === "string" ? m.position : null,
        context: {
          ...((m.context ?? {}) as Record<string, unknown>),
          ...(region >= 0 ? { region } : {}),
        },
      });
    }
  }

  // Everything with no home in Hermes at all.
  const carry: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) if (!ENVELOPE_KEYS.has(k)) carry[k] = v;
  if (Object.keys(carry).length) {
    note(
      "envelope.carried-not-modelled",
      "hermes",
      `The envelope carried ${Object.keys(carry).join(", ")} at the top level, which Hermes has no table for.`,
    );
  }
  if ((envelope.series as unknown[] | undefined)?.length) {
    note(
      "series.nowhere-to-put-it",
      "hermes",
      "A series arrived with a rule and a list of instances. Hermes keeps recurrence on the block and has no series identity, so the rule cannot be attached to the thing it governs. It is carried whole and given back on export, which is honest and is not the same as understanding it.",
    );
  }
  if ((envelope.relations as unknown[] | undefined)?.length) {
    note(
      "relations.derived-not-stored",
      "hermes",
      "Relations arrived as edges. Hermes derives its edges from reference fields, prose and canvas connections rather than storing them, so an edge with no matching property or mention has nowhere to live. Carried whole.",
    );
  }

  return {
    types,
    blocks,
    memberships,
    carry,
    // Held apart from `carry` because they are keys the format knows and Hermes
    // does not: a blanket passthrough would sit them next to genuinely unknown
    // extensions and, worse, land them ahead of `format` in the re-export.
    series: (envelope.series as unknown[] | undefined) ?? [],
    relations: (envelope.relations as unknown[] | undefined) ?? [],
    findings: [...found.values()].sort((a, b) => b.count - a.count),
  };
}
