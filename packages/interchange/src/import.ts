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
    const placement = (c.placement ?? {}) as { semantic?: boolean; regions?: string[] };
    const names = placement.regions ?? [];
    const carried = (c.properties ?? {}) as Record<string, unknown>;
    const smart = (c.membership as { mode?: string } | undefined)?.mode === "query";

    blocks.push({
      id: String(c.id),
      blockTypeId: null,
      collectionKind: String(c.kind ?? "list"),
      content: null,
      properties: {
        ...carried,
        title: String(c.name ?? "Untitled"),
        ...(names.length
          ? { matrix_regions: names.map((n) => ({ title: n, tag: n })) }
          : {}),
        membership_mode: smart ? "smart" : "explicit",
        ...(smart ? { filter_query: (c.membership as { query?: unknown }).query ?? null } : {}),
      },
      archivedAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      tags: [],
    });

    for (const m of (c.members ?? []) as Record<string, unknown>[]) {
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
