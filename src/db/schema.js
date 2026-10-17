import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

// Better Auth owns the `user`, `session`, `account`, and `verification` tables.
// App tables deliberately use its text user id but do not create a duplicate user table.
export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: text("user_id").primaryKey(),
    displayName: text("display_name"),
    responseStyle: text("response_style").default("balanced").notNull(),
    customInstructions: text("custom_instructions").default("").notNull(),
    // `preferredModel` is an intentional account default. `lastUsedModel`
    // follows a person between devices when no explicit default is selected.
    preferredModel: text("preferred_model"),
    lastUsedModel: text("last_used_model"),
    productMode: text("product_mode").default("chat").notNull(),
    thinkingEffort: text("thinking_effort").default("normal").notNull(),
    isAdmin: boolean("is_admin").default(false).notNull(),
    // The Settings memory switch. Off: chats neither read nor save memory.
    memoryEnabled: boolean("memory_enabled").default(true).notNull(),
    // Set by the voice-usage reconciliation job when a user's unreported/
    // over-length Live Comet sessions exceed the abuse threshold. Cleared by
    // an admin after review.
    voiceSuspendedAt: timestamp("voice_suspended_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("user_profiles_admin_idx").on(table.isAdmin)],
);

// Projects and folders for Chat and Study (drizzle/0024). kind is "project"
// or "folder"; a project's instructions reach the model for every chat filed
// under it, a folder only groups. parentId puts a folder inside a project.
export const conversationGroups = pgTable(
  "conversation_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").default("folder").notNull(),
    mode: text("mode").default("chat").notNull(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    instructions: text("instructions").default("").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("conversation_groups_owner_id_unique").on(table.userId, table.id),
    index("conversation_groups_owner_mode_idx").on(table.userId, table.mode),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    model: text("model").notNull(),
    mode: text("mode").default("chat").notNull(),
    archived: boolean("archived").default(false).notNull(),
    groupId: uuid("group_id"),
    ...timestamps,
  },
  (table) => [
    index("conversations_user_updated_idx").on(table.userId, table.updatedAt),
    index("conversations_owner_group_idx").on(table.userId, table.groupId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)],
);

export const imageFolders = pgTable("image_folders", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("image_folders_owner_id_unique").on(table.userId, table.id),
]);

// Raw files live on the private backend volume. PostgreSQL holds ownership,
// lifecycle, and extracted-text metadata so the files are never public URLs.
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    originalName: text("original_name").notNull(),
    storedName: text("stored_name").notNull(),
    mimeType: text("mime_type").notNull(),
    kind: text("kind").default("document").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    extractedText: text("extracted_text"),
    extractionStatus: text("extraction_status").default("ready").notNull(),
    // Only set for generated images: the prompt that produced them and, for a
    // requested variation, the image it was generated from.
    prompt: text("prompt"),
    displayName: text("display_name"),
    folderId: uuid("folder_id"),
    parentAttachmentId: uuid("parent_attachment_id"),
    generationMeta: jsonb("generation_meta").default({}).notNull(),
    ...timestamps,
  },
  (table) => [
    index("attachments_user_created_idx").on(table.userId, table.createdAt),
    index("attachments_message_idx").on(table.messageId),
    uniqueIndex("attachments_stored_name_unique").on(table.storedName),
    index("attachments_owner_folder_created_idx").on(table.userId, table.folderId, table.createdAt, table.id),
    foreignKey({
      name: "attachments_folder_owner_fk",
      columns: [table.userId, table.folderId],
      foreignColumns: [imageFolders.userId, imageFolders.id],
    }),
  ],
);

export const memoryFacts = pgTable(
  "memory_facts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    content: text("content").notNull(),
    source: text("source").notNull(),
    // A durable fact belongs to a broad, product-defined bucket. `area` is an
    // optional named project/topic cluster (for example, "VibhavGPT").
    category: text("category").default("profile").notNull(),
    area: text("area"),
    ...timestamps,
  },
  (table) => [index("memory_facts_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    customerId: text("customer_id"),
    subscriptionId: text("subscription_id"),
    tier: text("tier").default("free").notNull(),
    status: text("status").default("active").notNull(),
    billingSource: text("billing_source").default("stripe").notNull(),
    providerProductId: text("provider_product_id"),
    providerBasePlanId: text("provider_base_plan_id"),
    providerPurchaseTokenHash: text("provider_purchase_token_hash"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    currentPeriodStartedAt: timestamp("current_period_started_at", { withTimezone: true }),
    currentPeriodEndsAt: timestamp("current_period_ends_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("subscriptions_user_unique").on(table.userId),
    uniqueIndex("subscriptions_customer_unique").on(table.customerId),
  ],
);

// A billing customer belongs to an app user even when they have never had a
// subscription. This prevents one-time credit Checkouts from becoming
// anonymous Stripe guest purchases.
export const billingCustomers = pgTable(
  "billing_customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    customerId: text("customer_id").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("billing_customers_user_unique").on(table.userId),
    uniqueIndex("billing_customers_customer_unique").on(table.customerId),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    costMicros: integer("cost_micros").default(0).notNull(),
    usageUnits: doublePrecision("usage_units").default(1).notNull(),
    thinkingEffort: text("thinking_effort").default("normal").notNull(),
    reservedTokens: integer("reserved_tokens").default(0).notNull(),
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("usage_events_user_created_idx").on(table.userId, table.createdAt)],
);

// An append-only entitlement ledger keeps purchases, reservations, and
// automatic failed-request refunds auditable. A balance is the sum of entries.
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    credits: integer("credits").notNull(),
    kind: text("kind").notNull(),
    usageEventId: uuid("usage_event_id").references(() => usageEvents.id, { onDelete: "set null" }),
    externalReference: text("external_reference"),
    ...timestamps,
  },
  (table) => [
    index("credit_ledger_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("credit_ledger_external_reference_unique").on(table.externalReference),
    index("credit_ledger_usage_event_idx").on(table.usageEventId),
  ],
);

// Reservation + reconciliation ledger for GPT-Live ("Comet") voice calls.
// Duration is metered (not message-counted), so each row is optimistically
// reserved at call start for the max seconds the tier/pool allows, then
// reconciled to the client-reported actual length when the call ends. Rows
// left in "reserved" past their reservation window are finalized by the
// reconciliation job as "incomplete" and charged in full, since we cannot
// verify actual usage for a client that never reported back.
export const voiceLiveSessions = pgTable(
  "voice_live_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    tier: text("tier").notNull(),
    requestedModel: text("requested_model").notNull(),
    actualModel: text("actual_model").notNull(),
    fairUseFallback: boolean("fair_use_fallback").default(false).notNull(),
    reservedSeconds: integer("reserved_seconds").notNull(),
    actualSeconds: integer("actual_seconds"),
    status: text("status").default("reserved").notNull(),
    // A reservation is billable only after the browser confirms its WebRTC
    // connection. Heartbeats give reconciliation a server-recorded activity
    // bound when the browser cannot report a clean hangup.
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("voice_live_sessions_user_created_idx").on(table.userId, table.createdAt),
    index("voice_live_sessions_status_created_idx").on(table.status, table.createdAt),
  ],
);

// The blog feature (routes, page, API) was removed; this table definition is
// deliberately kept so the existing blog_posts table stays described. Deleting
// it would make the next generated migration try to DROP the table and take
// its rows with it — removing the feature should not destroy the data.
export const blogPosts = pgTable(
  "blog_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull(),
    content: text("content").notNull(),
    seoDescription: text("seo_description"),
    coverImage: text("cover_image"),
    isPublished: boolean("is_published").default(false).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("blog_posts_slug_unique").on(table.slug), index("blog_posts_published_idx").on(table.isPublished, table.publishedAt)],
);

