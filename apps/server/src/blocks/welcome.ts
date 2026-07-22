import { and, eq } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { blocks, blockTypes, memberships } from "@hermes/db";
import type { Database } from "@hermes/db";
import { computeEmbedSource } from "./embed-source.js";

type Db = Pick<Database, "insert" | "select">;

const WELCOME_NOTE = `# Welcome to Hermes 👋

Everything here is a **block** — notes, tasks, events, people, even collections.

- **Click a block** to open it in the **info panel** on the right: edit it, see its connections, star it (★) for Favorites.
- **Today** is your daily note — a scratchpad that keeps one sheet per day.
- In any text, type **@** to mention a person, **#** to tag, and **|** to link any block or collection. Links become chips that open in the info panel.
- The **+ button** in the left rail creates notes, blocks, and collections from anywhere.
- **Search** (top bar) matches titles, bodies, and properties — and also finds things by *meaning*, so describing what you want works too.

Delete this note whenever you're done with it.`;

const COLLECTIONS_NOTE = `# Collections, briefly

A **collection** is an ordered, filterable grouping of blocks. Four kinds:

- **List** — one line per item: bullet, ordered, checklist, or full blocks. Blocks format gets Block / Masonry / Chips views.
- **Spread** — full-card sections you arrange with the layout tool (this "Start here" is a spread).
- **Matrix** — an x/y grid of regions (Eisenhower 2×2, Kanban 3×1…): drag blocks in from a drawer.
- **Table** — a spreadsheet: one row per block, property columns you pick, inline editing, right-click headers to sort.

Membership is **Manual** (you add blocks) or **Smart** (a query decides — build it in the right panel, live-updating or snapshot).`;

const CHECKLIST_ITEMS = [
  "Create a note with the + button in the left rail",
  "Open All blocks and build a filter in the right panel",
  "Save that filter as a smart collection",
  "Star a block with the ★ in the info panel — it appears in Favorites",
  "Make a table collection and right-click a column header to sort",
  "Try a semantic search — describe what you're looking for in the top bar",
];

/** Title/description embed source, mirroring the collections routes. */
const collectionEmbed = (title: string, description: string) =>
  [title, description].filter((v) => v.trim().length > 0).join("\n");

/**
 * Seed a "Start here" spread for a fresh account: a welcome note, a
 * getting-started checklist (a nested list collection), and a collections
 * explainer. Best-effort — called outside the signup transaction so a failure
 * here never blocks registration.
 */
export async function seedWelcomeContent(db: Db, ownerId: string): Promise<void> {
  const [textType] = await db
    .select()
    .from(blockTypes)
    .where(and(eq(blockTypes.ownerId, ownerId), eq(blockTypes.isText, true)))
    .limit(1);
  if (!textType) return;

  const textBlock = async (content: string) => {
    const [row] = await db
      .insert(blocks)
      .values({
        ownerId,
        blockTypeId: textType.id,
        content,
        properties: {},
        embedSource: computeEmbedSource(textType, { content }),
        embedSourceHash: null,
        blockTypeSchemaVersion: textType.schemaVersion,
      })
      .returning({ id: blocks.id });
    return row!.id;
  };

  const collection = async (
    kind: "document" | "list",
    title: string,
    description: string,
    extra: Record<string, unknown>,
  ) => {
    const properties = {
      title,
      description,
      membership_mode: "explicit",
      icon_key: kind === "document" ? "file-text" : "list",
      icon_color: "#5fa4b5",
      ...extra,
    };
    const [row] = await db
      .insert(blocks)
      .values({
        ownerId,
        blockTypeId: null,
        collectionKind: kind,
        properties,
        embedSource: collectionEmbed(title, description),
        embedSourceHash: null,
      })
      .returning({ id: blocks.id });
    return row!.id;
  };

  const addMembers = async (
    collectionId: string,
    items: { blockId: string; context?: Record<string, unknown> }[],
  ) => {
    let pos: string | null = null;
    for (const it of items) {
      pos = generateKeyBetween(pos, null);
      await db
        .insert(memberships)
        .values({ collectionId, blockId: it.blockId, position: pos, context: it.context ?? {} })
        .onConflictDoNothing();
    }
  };

  // The nested checklist: one text block per step.
  const checklistId = await collection(
    "list",
    "Getting started",
    "A short tour of Hermes, as a checklist.",
    { list_format: "checklist", sort_mode: "manual", sync_checkbox_with_status: true },
  );
  const stepIds: string[] = [];
  for (const step of CHECKLIST_ITEMS) stepIds.push(await textBlock(step));
  await addMembers(
    checklistId,
    stepIds.map((blockId) => ({ blockId, context: { checked: false } })),
  );

  // The spread that fronts everything.
  const welcomeId = await textBlock(WELCOME_NOTE);
  const collectionsNoteId = await textBlock(COLLECTIONS_NOTE);
  const spreadId = await collection(
    "document",
    "Start here",
    "How to use Hermes: blocks, the info panel, mentions, and collections.",
    {},
  );
  await addMembers(spreadId, [
    { blockId: welcomeId },
    { blockId: checklistId },
    { blockId: collectionsNoteId },
  ]);
}
