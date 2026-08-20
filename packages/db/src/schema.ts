import {
  bigserial,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres bytea <-> Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
import type { CollectionKind, MembershipContext, PropertySchema } from "@hermes/shared";
import { vector } from "./vector.js";

// EMBEDDING_INDEX_DIM — keep in sync with migrations/0000_init.sql and .env.
export const EMBEDDING_INDEX_DIM = 2000;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  ollamaUrl: text("ollama_url"),
  embedModel: text("embed_model"),
  embedDim: integer("embed_dim"),
  inferenceModel: text("inference_model"),
  // UI preferences that sync across devices (e.g. Inbox pill colors).
  preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
  // Default semantic-similarity floor used where no per-query slider exists.
  defaultSimilarity: real("default_similarity").notNull().default(0.75),
  // IANA timezone (e.g. "America/New_York") for day boundaries; null = server local.
  timezone: text("timezone"),
  // Auto-archive completed tasks this many days after they were marked done.
  // Null or 0 = off. A daily job (like backups) runs the sweep.
  autoarchiveDoneDays: integer("autoarchive_done_days"),
  // Turns the assistant may take on one message before stopping to ask. Null =
  // the built-in default; a model that calls one tool at a time needs more of
  // them than one that batches, so it's per-user.
  assistantMaxSteps: integer("assistant_max_steps"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const blockTypes = pgTable(
  "block_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    iconKey: text("icon_key"),
    iconColor: text("icon_color"),
    iconSource: text("icon_source").notNull().default("lucide"),
    showIcon: boolean("show_icon").notNull().default(true),
    propertySchema: jsonb("property_schema").$type<PropertySchema>(),
    schemaVersion: integer("schema_version").notNull().default(1),
    isText: boolean("is_text").notNull().default(false),
    // Seeded core type (text/task/event): can't be deleted; has locked fields.
    builtin: boolean("builtin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ ownerName: unique().on(t.ownerId, t.name) }),
);

export const blocks = pgTable("blocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Null for collections (blocks with collection_kind set).
  blockTypeId: uuid("block_type_id").references(() => blockTypes.id),
  collectionKind: text("collection_kind").$type<CollectionKind>(),
  content: text("content"),
  properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
  embedSource: text("embed_source"),
  embedSourceHash: text("embed_source_hash"),
  embeddedAt: timestamp("embedded_at", { withTimezone: true }),
  blockTypeSchemaVersion: integer("block_type_schema_version").notNull().default(1),
  version: integer("version").notNull().default(1),
  // When set, the block is archived: hidden from every normal query and only
  // visible on the Archive page. Never set for collections. Null = active.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const blockEmbeddings = pgTable("block_embeddings", {
  blockId: uuid("block_id")
    .primaryKey()
    .references(() => blocks.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  dim: integer("dim").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_INDEX_DIM }).notNull(),
  embeddedAt: timestamp("embedded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    blockId: uuid("block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    /** Fractional index — sorts BETWEEN its neighbours, and only if compared
     *  by bytes. The column is COLLATE "C" for that reason (migration 0028);
     *  under a language collation "Zz" sorts after "a0" and the top of every
     *  list is wrong. */
    position: text("position"),
    region: text("region"),
    context: jsonb("context").$type<MembershipContext>().notNull().default({}),
    hidden: boolean("hidden").notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ collectionBlock: unique().on(t.collectionId, t.blockId) }),
);

export const blockRelations = pgTable(
  "block_relations",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sourceId, t.targetId, t.relationType] }) }),
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => ({ ownerName: unique().on(t.ownerId, t.name) }),
);

export const blockTags = pgTable(
  "block_tags",
  {
    blockId: uuid("block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.blockId, t.tagId] }) }),
);

/** Files uploaded against a block, stored inline (bytea) in the database. */
export const banners = pgTable("banners", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** External calendar subscriptions (ICS URLs). Events are fetched live, not stored. */
export const calendarFeeds = pgTable("calendar_feeds", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  color: text("color").notNull().default("#6b7cff"),
  enabled: boolean("enabled").notNull().default(true),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  lastError: text("last_error"),
  /** What the calendar host actually said, for the diagnostics dialog. */
  lastStatus: integer("last_status"),
  lastDetail: text("last_detail"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  /**
   * The last ICS body we successfully read, and the validators to ask about it
   * with. Kept so the calendar can render immediately from the stored copy while
   * a refresh happens behind it — an empty calendar waiting on someone else's
   * server is the thing this avoids.
   */
  cacheText: text("cache_text"),
  cachedAt: timestamp("cached_at", { withTimezone: true }),
  etag: text("etag"),
  lastModified: text("last_modified"),
  sort: integer("sort").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Feed events promoted to Hermes blocks — filtered out of the feed thereafter. */
export const calendarConverted = pgTable("calendar_converted", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  feedId: uuid("feed_id").references(() => calendarFeeds.id, { onDelete: "cascade" }),
  uid: text("uid").notNull(),
  // Deleting the synced block drops this row too, so the feed event reappears.
  blockId: uuid("block_id").references(() => blocks.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("sync"),
  /**
   * The feed-owned property values as the feed last reported them. Lets a later
   * fetch tell a genuine feed change from an edit the user made here, so
   * mirroring the feed never overwrites the user's own text. Null on rows
   * predating this column — treated as "adopt the current feed as the baseline
   * without touching the block".
   */
  lastFeed: jsonb("last_feed").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockId: uuid("block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** Persisted AI-assistant conversation — one ongoing thread per user, with the
 * occasional 'summary' row condensing older turns near the context limit. */
export const assistantMessages = pgTable("assistant_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  seq: bigserial("seq", { mode: "number" }).notNull(),
  role: text("role").notNull(),
  kind: text("kind").notNull().default("message"),
  content: text("content").notNull().default(""),
  steps: jsonb("steps").$type<AgentStep[] | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A tool call the assistant made during a turn (mirrors the agent's AgentStep). */
export interface AgentStep {
  tool: string;
  args: unknown;
  result: string;
  ok: boolean;
}

/**
 * Every block that changed, one row per write, put here by a database trigger
 * rather than by the code that did the writing (see migration 0027).
 *
 * Written by the database, read by the app: nothing inserts into this from
 * TypeScript, and nothing should. The point of it is that it sees writes the
 * writer never thought to announce — a note re-seeded while somebody merely
 * looked at the day, a sweep clearing away what nobody wrote in.
 */
export const changes = pgTable("changes", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  blockId: uuid("block_id").notNull(),
  /** insert | update | delete */
  op: text("op").notNull(),
  /** The block's version after the write; null on a delete or a child-row change. */
  version: integer("version"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
