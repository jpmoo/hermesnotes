import { and, eq } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { blocks, blockTypes, memberships } from "@hermes/db";
import type { Database } from "@hermes/db";
import { computeEmbedSource } from "./embed-source.js";

type Db = Pick<Database, "insert" | "select">;

const WELCOME_NOTE = `# Welcome to Hermes 👋

Everything here is a **block** — notes, tasks, events, people, projects, even collections.

- **Click a block** to open it in the right **panel**, which has three tabs: **Info** (edit it in place, see its connections, star it ★ for **Favorites**), **Graph** (a live map of what it links to), and **AI**.
- **AI assistant** (AI tab): ask in plain language to find, create, or organize anything — it uses the same tools you do, and remembers the conversation across sessions (clear it anytime). Point it at an Ollama model in **Settings** first.
- The left rail is your home base: **New…** (a block of any type, or a collection), **Search**, **Today**, **Favorites**, **All blocks**, **Collections**, and **Types**. Each row is colorable — hover it and use the ⋮ menu.
- **Today** is your daily note — a per-day scratchpad with a calendar to jump between days. Pin collections or notes onto it as sections, scoped to **just today**, **today and future days**, or **all dailies**.
- **Tasks & Projects** are built in. Give a task a **Project** to group your work; the project then shows everything linked to it.
- In any text box — even titles — type **@** to mention a person, **#** to tag, and **|** to link any block. Picks become chips that open in the panel; mention a person who doesn't exist yet and they're created for you. Rename a person or tag and every reference updates.
- Select text in any long field and **right-click → extract to a new block** — the selection becomes its own block, linked back from where it was.
- **Search** (rail) lists keyword **Matches** and semantic **Similar** results — describing what you want in your own words works too.
- Subscribe to external **calendars** (ICS) in Settings — their events show in **Today** and any **Calendar** collection.
- On a **phone**, the rail becomes a drop-down and the panel a tab — everything's still here, just reshaped.

Delete this note whenever you're done with it.`;

const COLLECTIONS_NOTE = `# Collections, briefly

A **collection** is an ordered, filterable grouping of blocks. Pick the kind that fits how you want to see them:

- **List** — one line per item: bullet, ordered, checklist, or full blocks (with Block / Masonry views and per-card collapse).
- **Spread** — full-card sections you arrange with the layout tool (this "Start here" is a spread).
- **Matrix** — an x/y grid of regions (Eisenhower 2×2, Kanban 3×1…). Drag blocks in from the drawer, or bind regions to a **status** (they become the columns) or to **dates** (day columns with movable row-regions). Regions can even act — add a tag or set a status when a card enters.
- **Table** — a spreadsheet: one row per block, property columns you choose, inline editing, click a header to sort.
- **Canvas** — a freeform board: place blocks anywhere, draw connections, group them into regions. A **lock** toggle freezes the layout so you can browse (and still edit a block's contents) without nudging anything.
- **Calendar** — your dated blocks laid out by month, week, or 3-day.

Membership is **Manual** (you add blocks) or **Smart** (a query decides — build it in the right panel, live-updating or snapshot). Save any **All blocks** filter straight into a smart collection.`;

const CHECKLIST_ITEMS = [
  "Make a note from the rail's New… button",
  "In its title, type @ to mention someone (a new person is created), and # to tag",
  "Star a block with the ★ in the info panel — it shows up in Favorites",
  "Open the AI tab in the right panel and ask it to create or find something (set an Ollama model in Settings first)",
  "Create a Project, then make a task and link it to that project",
  "Open All blocks, build a filter in the right panel, and Save as collection",
  "Create a Matrix collection and drag a few tasks into its regions",
  "Try a Search from the rail — compare the keyword Matches with the Similar (semantic) results",
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
    "How to use Hermes: blocks, the info panel, mentions, favorites, and every collection kind.",
    {},
  );
  await addMembers(spreadId, [
    { blockId: welcomeId },
    { blockId: checklistId },
    { blockId: collectionsNoteId },
  ]);
}
