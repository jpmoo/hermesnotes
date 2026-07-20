# Hermes Notes — v2 Design Reference

Ground-up rebuild of Hermes as a block-first PKMS. This document consolidates the data model and design decisions made to date. It is a living reference, not a spec frozen in stone — sections marked **Open** still need a decision before implementation.

---

## 1. Core philosophy

- **Everything is a block.** A note is not a file — it's a collection of blocks, and a block is the atomic, independently addressable unit.
- **A block can belong to multiple places at once.** Membership in a collection is a relationship, not ownership. The same block can appear in a document, a kanban board, and a canvas simultaneously.
- **Every block is embedded**, no matter its type — either its text content, or a declared set of "ingredient" fields.
- **Collections are just blocks** with a `collection_kind` set. An embedded kanban view inside a document is not a special case — it's a block (the kanban) that happens to be a member of another collection (the document).

---

## 2. Core schema

```sql
blocks (
  id uuid primary key,
  block_type_id uuid references block_types(id),
  collection_kind text,        -- null unless this block IS a collection:
                                -- 'document' | 'matrix' | 'kanban' | 'table'
                                -- | 'canvas' | 'masonry' | 'list'
  content text,                 -- used by basic text blocks only
  properties jsonb,             -- type-specific fields, incl. title/description for non-text types
  embed_source text,            -- denormalized: exact string that was embedded
  embed_source_hash text,       -- hash of embed_source; skip re-embed if unchanged
  embedding vector(1536),
  embedded_at timestamptz,
  block_type_schema_version integer default 1,  -- tracks which schema_version produced embed_source
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)

block_types (
  id uuid primary key,
  name text,
  icon_key text,                -- Lucide/Tabler icon name
  icon_color text,               -- hex or semantic token
  icon_source text default 'lucide',  -- 'lucide' | 'custom' (escape hatch for future upload)
  show_icon boolean default true,      -- toggle: render icon in editing pane?
  property_schema jsonb,         -- field definitions (see §3)
  schema_version integer default 1,    -- bumped on property_schema change → triggers re-embed cascade
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)

memberships (
  id uuid primary key,
  collection_id uuid references blocks(id),
  block_id uuid references blocks(id),
  position text,                 -- fractional index, scoped to collection_id
  region text,                    -- 'header' | 'body' | 'footer' — document kind only
  context jsonb,                   -- kind-specific placement data (see §5)
  hidden boolean default false,     -- smart collections only; unused for manual
  version integer default 1,         -- optimistic concurrency control
  created_at timestamptz default now()
)

block_relations (
  source_id uuid references blocks(id),
  target_id uuid references blocks(id),
  relation_type text,            -- 'links_to' | 'references' | etc. — non-positional links/backlinks
  created_at timestamptz default now()
)

tags (id uuid primary key, name text unique)
block_tags (block_id uuid references blocks(id), tag_id uuid references tags(id))
```

**Indexes to add:** `memberships(block_id)`, `memberships(collection_id)` — both are on the hot path for inbox queries and collection rendering.

---

## 3. block_types and property_schema

`property_schema` is the single source of truth for the editing form, the embedding pipeline, and (for status fields) kanban/checklist logic. No per-type hardcoded logic — everything is declarative.

```json
{
  "fields": [
    { "key": "title", "type": "text", "order": 0, "includeEmbed": true },
    { "key": "description", "type": "text", "order": 1, "includeEmbed": true },
    { "key": "due_date", "type": "date", "order": 2, "includeEmbed": false },
    {
      "key": "status",
      "type": "status",
      "order": 3,
      "includeEmbed": false,
      "options": ["not_started", "in_progress", "blocked", "done", "archived", "wont_do"]
    }
  ],
  "status_field": "status",
  "complete_values": ["done", "archived", "wont_do"],
  "default_value": "not_started"
}
```

**Rules:**
- Every non-text block type must include a `title` field (convention, validated at block-type-creation time — not a hardcoded column).
- `order` (explicit int, not array position) drives `embed_source` concatenation order — don't rely on jsonb array order surviving round-trips in all tooling.
- `status_field` / `complete_values` / `default_value` live at the schema level, not per-option — see §7.
- `includeEmbed` changes on any field trigger the **immediate cascade** (§4): bump `schema_version`, mark all instances stale, re-embed.

---

## 4. Embedding pipeline

**Derivation (generic, not per-type):**

```
embed_source = fields
  .filter(f => f.includeEmbed)
  .sort(f => f.order)
  .map(f => properties[f.key])
  .filter(Boolean)
  .join("\n")
```

Text blocks are the exception: `embed_source = content` directly (no `property_schema` fields).

**Hash-gate:** compute `hash(embed_source)`, compare to stored `embed_source_hash`. Only call the embedding API on mismatch. This is what keeps checklist-toggle-style edits (which don't touch embedded fields) cheap.

**Cascade on block_type schema change (immediate, not versioned):**
1. `property_schema` edited → bump `block_types.schema_version`
2. Enqueue: mark all blocks of that type stale (`embed_source_hash = NULL`, or direct recompute if volume is low enough to do synchronously)
3. Background worker recomputes `embed_source`, re-embeds, updates `embedded_at`

**Children are never embedded into a parent's embedding.** Collections embed only their own `title`/`description` fields (per `includeEmbed`), never a rollup of child content. Search surfaces the matching child block with a breadcrumb to its parent, not the parent itself.

**Icon/color/show_icon changes never trigger re-embed** — purely cosmetic metadata, outside the schema_version/cascade system entirely. They get `updated_at` bumped like any other column, full stop.

---

## 5. Collection kinds

A collection is a block with `collection_kind` set. All six/seven kinds share the same `memberships` table; they differ in what they store in `context` and how they interpret `position`.

| Kind | Positioning mechanism | context fields |
|---|---|---|
| `document` | `position` (fractional index) + `region` | — |
| `list` | `position` (manual) or live sort by field | `checked` (only if not syncing to status — see §7) |
| `matrix` / `kanban` | derived from field values | `row_key`, `col_key` |
| `table` | `position` only (row order) | — |
| `masonry` | `position` (sort order → algorithmic grid layout) | `size_override: {w,h}`, `collapsed` |
| `canvas` | free spatial | `x`, `y`, `docked`, `excluded` n/a (see hidden, §6) |

### 5a. List — detail

```sql
-- on the list collection block:
properties: {
  "list_format": "bullet" | "ordered" | "checklist",
  "sort_mode": "manual" | "alpha" | "created_at" | "due_date" | "custom_field",
  "sort_field": null,              -- only used when sort_mode = 'custom_field'
  "sort_direction": "asc" | "desc",
  "sync_checkbox_with_status": true   -- see §7
}
```

- Items are real child blocks of **any** block type (text, task, event, etc.) via normal `memberships` rows — not a special "list item" block type.
- `sort_mode: manual` → `position` drives display order, drag-to-reorder writes new fractional indices.
- Any other `sort_mode` → `position` is vestigial; renderer sorts live by the chosen field. Dragging while in a non-manual sort mode should prompt "switch to manual sort?" rather than silently ignoring the drag or silently switching modes. **(Open: confirm this UX.)**
- Can be manual or smart, same as any other collection — smart list: filter determines membership, no manual add, `hidden` available per item, `sort_mode` still governs display order of the matched set.

### 5b. Masonry — detail

- Positioning is algorithmic (packed grid), not user-placed — mechanically closer to `document` (ordering) than `canvas` (spatial).
- `allow_tile_override` (collection-level toggle): when `false`, `size_override` is ignored entirely, pure auto-layout by content. When `true`, `size_override` is honored per-tile where set, auto for the rest. Reversible either direction — no data loss on toggle.
- `collapsed` (membership-level): overrides both auto-layout and `size_override` — renders at fixed minimal footprint. Precedence: `collapsed` > `size_override` (if enabled) > auto.
- **(Open)** Whether `collapsed` should be standardized as a generic membership-level flag usable by any collection kind with hierarchical/nested display (e.g. document blocks with children), rather than masonry-specific.

### 5c. Canvas — detail (dock, inbox for canvas)

- `context: { x, y, docked, hidden }` — `x`/`y` are `null` while `docked: true`.
- **Dock = a canvas inbox.** Scrollable/draggable staging tray for members with no spatial position yet. Membership-mode-agnostic: works identically for smart-matched and explicitly-added blocks.
- New member (smart match or explicit add) → enters dock (`docked: true`, x/y null). No auto-placement strategy needed — the dock *is* the default.
- Dock → canvas: user drags out, `docked: false`, `x`/`y` set.
- Canvas → dock: `docked: true`, x/y nulled. This is the "rapid transport across the whole canvas" move — same operation regardless of how the block arrived.
- **Removal, manual canvas:** two-step by design — must dock first (`docked: true`), *then* delete the membership row. Delete is not available directly from a placed (non-docked) state. Deliberate forcing function against accidental deletes.
- **Removal, smart canvas:** memberships are filter-derived, so nothing to delete — only `hidden: true` is valid (see §6). Can be set from dock or from canvas directly, no forced intermediate step (exclusion is non-destructive, unlike delete).

---

## 6. Membership lifecycle: explicit vs. smart, hidden

```sql
-- on any collection block:
properties: {
  "membership_mode": "explicit" | "smart",
  "filter_query": {                 -- only used when smart
    "tags": ["ireland"],
    "block_type": "event",
    "properties_match": { "date": { "after": "2026-08-01" } },
    "text_search": null
  }
}
```

- **Explicit collections**: user adds/removes membership rows directly. Delete is a real, destructive action (with the dock-first caveat for canvas).
- **Smart collections**: membership rows are computed from `filter_query`. Materialize on write-through — when a block is created/edited/tagged, re-evaluate active smart collections, upsert/delete relevant `memberships` rows. Keeps read performance identical to explicit collections.
- **New smart matches** land per the kind's default: dock (canvas), append-to-body (document), end-of-list (masonry/table/list).
- **`hidden`** (renamed from "excluded"): smart-collection-only concept. Membership row persists — `hidden` just suppresses it from the default view. A "show hidden" toggle on any smart-collection view runs the same query with `hidden = true`. Un-hiding flips the boolean back; no reconciliation needed. **Manual collections never use `hidden`** — if you don't want a block in an explicit collection, you remove the membership. The delete/hide split is fully determined by checking the parent's `membership_mode` — no other per-kind branching required.

---

## 7. Status fields and checklist sync

Status is a first-class field **type**, not a boolean:

```json
{
  "key": "status",
  "type": "status",
  "options": ["not_started", "in_progress", "blocked", "done", "archived", "wont_do"]
}
```

Completion semantics are declared at the block_type level, set at construction time — not inferred from option names, not per-option metadata:

```json
{
  "status_field": "status",
  "complete_values": ["done", "archived", "wont_do"],
  "default_value": "not_started"
}
```

**Checklist sync** (list property `sync_checkbox_with_status`, default `true`):
- **`true`**: checklist checkbox reads/writes the child block's own status field directly.
  - Checked ⟺ `properties[status_field]` is in `complete_values`.
  - Unchecking → writes `default_value`.
  - Checking, with multiple `complete_values` → writes the **first** entry by default (fast single-click, matches checklist muscle memory); a secondary picker (right-click / long-press) lets the user choose a specific terminal state when they're not interchangeable (e.g. `done` vs `wont_do`).
  - Children whose block_type has no `status_field` fall back to plain-bullet rendering (can't sync).
- **`false`**: list keeps its own local checkbox state per membership row (`context.checked`), independent of any underlying block property. Useful for lists where "checked here" has no relation to the item's own state (e.g. a personal reading-progress list of book blocks).

**Kanban/matrix column derivation** can reuse this: group by `status_field`, generate columns from `options` in order, and get a free "done vs. not" split via `complete_values` — e.g. a generic "hide completed" toggle with zero per-type logic.

---

## 8. Task as a first-class block type

- A task is **its own block**, not a checkbox variant of a text block. Its own icon, own `property_schema` (status, due_date, assignee, priority, etc.), own embedding, independently linkable/movable — same tier as event, table, or any other type.
- Ordered/unordered/checklist rendering is **not** a task concept — it's a `list_format` property on the `list` collection kind (§5a). A checklist is a list of blocks (of any type) rendered with checkboxes; a task happening to live inside a checklist-formatted list is the common case, not a special one.

---

## 9. Inbox

Pure query, no stored flag — derived entirely from `memberships`:

```sql
-- "in the inbox" = no parent AND no children
SELECT b.* FROM blocks b
WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.block_id = b.id)
  AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.collection_id = b.id);
```

- Adding a block to any collection removes it from inbox automatically (membership row created).
- Removing a block's only membership returns it to inbox automatically — no explicit "orphan" event needed.
- **(Open)** Empty collections (collection_kind set, zero children) technically satisfy "no children" and would show in inbox under the literal query. Decide: is that acceptable (nudges the user to fill or file an empty board), or should collections be exempted purely by having `collection_kind IS NOT NULL`, regardless of child count?
- Docked canvas items still have a live membership row → correctly excluded from inbox.
- Hidden smart-collection items still have a live membership row → correctly excluded from inbox (hidden ≠ orphaned).

---

## 10. Icon system

- **Library:** Lucide (aliased via Tabler outline set in tooling) — large, tree-shakeable, semantic kebab-case names.
- Store `icon_key` (name string) + `icon_color` + `icon_source` (`'lucide' | 'custom'`, escape hatch for future user-uploaded SVG — not built in v1, but the discriminator exists now to avoid a later migration).
- Fallback to a generic default icon if `icon_key` is null or removed in a future Lucide version bump.
- `show_icon` (boolean, per block_type): toggles whether the icon renders in the editing pane. Cosmetic, no cascade implications.
- Seed defaults for known v1 types: task → `check-square`, event → `calendar`, table → `table`, kanban → `kanban`, canvas → `layout-grid`, document → `file-text`, list → `list`.

---

## 11. Optimistic concurrency (multi-client, single-user)

Single user, multiple clients (web + desktop) — detection + sane default resolution, no merge negotiation needed.

- `version` integer on `blocks` and `memberships`. Every write: `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?client_saw_version`. Zero rows affected = conflict.
- **Content conflicts** (the `content`/text body field): don't auto-merge — surface both versions to the user, let them pick or keep both as a duplicate block. Rare in practice (same block, same moment, two devices) but should never silently eat text.
- **`properties` jsonb**: auto-merge field-by-field, last-write-wins per key. A `due_date` edit on one device and a `tags` edit on another are independent — no reason to conflict-block those.
- **Position conflicts**: self-healing via fractional indexing. Simultaneous inserts at "the same" position almost always generate distinct valid strings; on exact collision, tie-break deterministically by `(position, block_id)` at read time. No CRDT sequence types needed — that solves a problem this app doesn't have.
- **Sync transport**: polling or Postgres `LISTEN/NOTIFY` / lightweight websocket for changed-block-IDs-since-last-sync. No offline-first queue/replay engine unless desktop is expected to work genuinely offline for real stretches (train, no wifi) — **(Open: confirm desktop's offline expectations before committing to the simpler transport.)**

---

## 12. Typography and visual system (Hermes Notes brand)

- **Body / content text:** Verdana — wide, high x-height, warm and legible for prose, block content, card titles.
- **Interface chrome:** Tahoma — sidebar nav, tags/pills, column headers, metadata labels. Close cousin to Verdana, so the register shift is subtle rather than jarring.
- **Palette:** light shades / white / gray. Muted hairline borders (`~1px`, low-contrast gray) with a soft shadow for lift (`0 1px 3px rgba(0,0,0,0.06)` scale, not heavy).
- **Corners:** consistently rounded — cards ~12px, smaller controls/pills ~8–12px.
- **Color usage:** reserved primarily for per-block-type icon color (user-selectable per type, §10) and small semantic accents (tag pills, smart-collection badges) — not used for large surface fills. Keeps the base UI monochrome/neutral and lets icon color do the type-differentiation work.
- **(Open)** Card density budget for kanban/masonry at scale — decide a hard cap (e.g. title + max 2 metadata chips visible on a collapsed card) before density creep happens organically as more block types/properties get added.

---

## 13. Open decisions summary

For quick reference — items flagged `(Open)` above:

1. Empty (child-less) collections: exempt from inbox by `collection_kind IS NOT NULL`, or let them appear as a literal reading of "no children"?
2. Dragging to reorder a list while in a non-manual `sort_mode`: prompt to switch to manual, silently ignore, or silently switch?
3. Should membership-level `collapsed` (introduced for masonry) be generalized to a standard field usable by any collection kind with nested/hierarchical display?
4. Desktop client offline expectations — determines whether sync transport can stay simple (poll/LISTEN-NOTIFY) or needs an offline queue/replay engine.
5. Card density cap for kanban/masonry views as more properties get added per block type.
