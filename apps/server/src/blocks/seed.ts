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
        { key: "due_date", type: "date", order: 2, includeEmbed: false, locked: true },
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
    name: "event",
    isText: false,
    builtin: true,
    propertySchema: {
      fields: [
        { key: "title", type: "text", order: 0, includeEmbed: true, locked: true },
        { key: "description", type: "longtext", order: 1, includeEmbed: true, locked: true },
        { key: "start", type: "datetime", order: 2, includeEmbed: false, locked: true },
        { key: "end", type: "datetime", order: 3, includeEmbed: false, locked: true },
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
        iconSource: "lucide" as const,
      })),
    )
    .returning({ id: blockTypes.id, name: blockTypes.name });

  // Wire the person/organization reference fields to the organization type.
  const orgId = inserted.find((t) => t.name === "organization")?.id;
  if (!orgId) return;
  for (const t of SEED_TYPES) {
    if ((t.name !== "person" && t.name !== "organization") || !t.propertySchema) continue;
    const typeId = inserted.find((i) => i.name === t.name)?.id;
    if (!typeId) continue;
    const schema: PropertySchema = {
      ...t.propertySchema,
      fields: t.propertySchema.fields.map((f) =>
        f.type === "reference" ? { ...f, refTypeId: orgId } : f,
      ),
    };
    await db.update(blockTypes).set({ propertySchema: schema }).where(eq(blockTypes.id, typeId));
  }
}
