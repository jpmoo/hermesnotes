import { eq } from "drizzle-orm";
import { DEFAULT_TYPE_ICONS, type PropertySchema } from "@hermes/shared";
import { blockTypes } from "@hermes/db";
import type { Database } from "@hermes/db";

/** Accepts either the base db handle or a transaction — both expose insert/update. */
type Inserter = Pick<Database, "insert" | "update">;

interface SeedType {
  name: string;
  isText: boolean;
  builtin: boolean;
  propertySchema: PropertySchema | null;
  iconColor?: string | null;
}

/**
 * Default block types seeded per-user at signup (design doc §10 — the seed
 * defaults are per-user rows here, not global constants). Phase 1 only exercises
 * `text`; the rest are declared so the type palette exists from day one.
 */
const SEED_TYPES: SeedType[] = [
  {
    name: "text",
    isText: true,
    builtin: true,
    propertySchema: {
      fields: [
        { key: "description", label: "Body", type: "longtext", order: 0, includeEmbed: true, locked: true },
        // Files were always attachable — they hang off block_id, not off a
        // property — but with no field on the type there was nowhere in the
        // editor to put one. Unlocked: removable by anyone who doesn't want it.
        { key: "attachments", label: "Attachments", type: "attachments", order: 1, includeEmbed: false },
      ],
    },
  },
  {
    name: "task",
    isText: false,
    builtin: true,
    propertySchema: {
      fields: [
        { key: "title", type: "text", order: 0, includeEmbed: true, locked: true },
        { key: "description", type: "longtext", order: 1, includeEmbed: true },
        {
          key: "schedule",
          label: "Schedule",
          type: "datespan",
          order: 2,
          includeEmbed: false,
          locked: true,
          startLabel: "Available",
          endLabel: "Due",
        },
        { key: "recurrence", label: "Recurrence", type: "recurrence", order: 4, includeEmbed: false, locked: true },
        { key: "project", label: "Project", type: "reference", order: 5, includeEmbed: false, locked: true },
        {
          key: "status",
          type: "status",
          order: 3,
          includeEmbed: false,
          locked: true,
          options: ["not_started", "in_progress", "blocked", "done", "archived", "wont_do"],
          optionIcons: {
            not_started: "circle",
            in_progress: "circle-dot-dashed",
            blocked: "ban",
            done: "circle-check",
            archived: "archive",
            wont_do: "circle-x",
          },
          optionColors: {
            not_started: "#9aa0a6",
            in_progress: "#4a7bb5",
            blocked: "#b5525f",
            done: "#2f6d4f",
            archived: "#9aa0a6",
            wont_do: "#8a6d1f",
          },
        },
      ],
      status_field: "status",
      complete_values: ["done", "archived", "wont_do"],
      default_value: "not_started",
    },
  },
  {
    name: "project",
    isText: false,
    builtin: true,
    iconColor: "#e8833a",
    propertySchema: {
      fields: [
        { key: "title", type: "text", order: 0, includeEmbed: true, locked: true },
        { key: "description", label: "About", type: "longtext", order: 1, includeEmbed: true, locked: true },
      ],
    },
  },
  {
    name: "event",
    isText: false,
    builtin: true,
    propertySchema: {
      fields: [
        { key: "title", type: "text", order: 0, includeEmbed: true, locked: true },
        { key: "description", type: "longtext", order: 1, includeEmbed: true, locked: true },
        {
          key: "when",
          label: "When",
          type: "datespan",
          order: 2,
          includeEmbed: false,
          locked: true,
          startLabel: "Start",
          endLabel: "End",
        },
        { key: "location", type: "text", order: 4, includeEmbed: true },
      ],
    },
  },
  {
    name: "organization",
    isText: false,
    builtin: true,
    propertySchema: {
      fields: [
        { key: "title", label: "Name", type: "text", order: 0, includeEmbed: true, locked: true },
        { key: "description", label: "About", type: "longtext", order: 1, includeEmbed: true, locked: true },
        // refTypeId wired to the organization type itself after insert.
        { key: "parent", label: "Parent Organization", type: "reference", order: 2, includeEmbed: false, locked: true },
      ],
    },
  },
  {
    name: "person",
    isText: false,
    builtin: true,
    propertySchema: {
      fields: [
        { key: "title", label: "Name", type: "text", order: 0, includeEmbed: true, locked: true },
        { key: "role", label: "Title/Role", type: "text", order: 1, includeEmbed: true, locked: true },
        { key: "description", label: "About", type: "longtext", order: 2, includeEmbed: true, locked: true },
        { key: "organization", label: "Organization", type: "reference", order: 3, includeEmbed: false, locked: true },
      ],
    },
  },
];

/** Which type each built-in reference field points at, keyed "<type>.<fieldKey>". */
const REF_TARGETS: Record<string, string> = {
  "organization.parent": "organization",
  "person.organization": "organization",
  "task.project": "project",
};

export async function seedBlockTypes(db: Inserter, ownerId: string): Promise<void> {
  const inserted = await db
    .insert(blockTypes)
    .values(
      SEED_TYPES.map((t) => ({
        ownerId,
        name: t.name,
        isText: t.isText,
        builtin: t.builtin,
        propertySchema: t.propertySchema,
        iconKey: DEFAULT_TYPE_ICONS[t.name] ?? null,
        iconColor: t.iconColor ?? null,
        iconSource: "lucide" as const,
      })),
    )
    .returning({ id: blockTypes.id, name: blockTypes.name });

  // Wire each built-in reference field to its target type now that ids exist.
  const idByName = new Map(inserted.map((t) => [t.name, t.id]));
  for (const t of SEED_TYPES) {
    if (!t.propertySchema?.fields.some((f) => f.type === "reference")) continue;
    const typeId = idByName.get(t.name);
    if (!typeId) continue;
    const schema: PropertySchema = {
      ...t.propertySchema,
      fields: t.propertySchema.fields.map((f) => {
        if (f.type !== "reference") return f;
        const target = idByName.get(REF_TARGETS[`${t.name}.${f.key}`] ?? "");
        return target ? { ...f, refTypeId: target } : f;
      }),
    };
    await db.update(blockTypes).set({ propertySchema: schema }).where(eq(blockTypes.id, typeId));
  }
}
