import { DEFAULT_TYPE_ICONS, type PropertySchema } from "@hermes/shared";
import { blockTypes } from "@hermes/db";
import type { Database } from "@hermes/db";

/** Accepts either the base db handle or a transaction — both expose `insert`. */
type Inserter = Pick<Database, "insert">;

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
        { key: "description", label: "Body", type: "text", order: 0, includeEmbed: true, locked: true },
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
        { key: "description", type: "text", order: 1, includeEmbed: true },
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
        { key: "description", type: "text", order: 1, includeEmbed: true },
        { key: "start", type: "datetime", order: 2, includeEmbed: false },
        { key: "end", type: "datetime", order: 3, includeEmbed: false },
        { key: "location", type: "text", order: 4, includeEmbed: true },
      ],
    },
  },
];

export async function seedBlockTypes(db: Inserter, ownerId: string): Promise<void> {
  await db.insert(blockTypes).values(
    SEED_TYPES.map((t) => ({
      ownerId,
      name: t.name,
      isText: t.isText,
      builtin: t.builtin,
      propertySchema: t.propertySchema,
      iconKey: DEFAULT_TYPE_ICONS[t.name] ?? null,
      iconSource: "lucide" as const,
    })),
  );
}
