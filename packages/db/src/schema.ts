import {
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
  blockId: uuid("block_id").references(() => blocks.id, { onDelete: "set null" }),
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
