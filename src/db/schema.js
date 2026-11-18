import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
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

// Raw bytes (a small picture), as Postgres's bytea.
const bytea = customType({ dataType: () => "bytea" });

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

// Better Auth owns the `user`, `session`, `account`, and `verification` tables.
// App tables deliberately use its text user id but do not create a duplicate user table.
// Saved avatars: reference photos kept for image generation. The server's own re-encoded copy, owned by one account.
export const savedAvatars = pgTable(
  "saved_avatars",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    data: bytea("data").notNull(),
    ...timestamps,
  },
  (table) => [index("saved_avatars_user_created_idx").on(table.userId, table.createdAt)],
);

// Account preferences that follow a person between devices. Kept apart from user_profiles so each can change on its own.
// Eligibility and agreements (drizzle/0054, src/account/agreements.js): the versions accepted and when, and the age check's result only.
export const accountAgreements = pgTable("account_agreements", {
  userId: text("user_id").primaryKey(),
  termsVersion: text("terms_version"),
  privacyVersion: text("privacy_version"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  ageCheck: text("age_check"),
  ageCheckedAt: timestamp("age_checked_at", { withTimezone: true }),
  ...timestamps,
});

export const accountPreferences = pgTable("account_preferences", {
  userId: text("user_id").primaryKey(),
  accent: text("accent"),
  watermarkEnabled: boolean("watermark_enabled").default(true).notNull(), // Legacy (an earlier opt-out policy); not read. See imageWatermark.
  // Paid plans' opt-in to the VibhavGPT mark on generated pictures (src/generation/watermark.js). Free plan pictures are always marked.
  imageWatermark: boolean("image_watermark").default(false).notNull(),
  locationMode: text("location_mode").default("off").notNull(),
  locationCity: text("location_city"),
  locationRegion: text("location_region"),
  locationCountry: text("location_country"),
  locationTimezone: text("location_timezone"),
  // Sidebar items this person hid (Settings > Sidebar), ids from SIDEBAR_ITEM_IDS in src/profile/preferences.js.
  sidebarHidden: jsonb("sidebar_hidden").default([]).notNull(),
  ...timestamps,
});

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
    // "Save new memories", separate from using them (drizzle/0046).
    memorySaveEnabled: boolean("memory_save_enabled").default(true).notNull(),
    // Set by the voice-usage reconciliation job when a user's unreported/
    // over-length Live Comet sessions exceed the abuse threshold. Cleared by
    // an admin after review.
    voiceSuspendedAt: timestamp("voice_suspended_at", { withTimezone: true }),
    // The onboarding survey, finished or skipped, on any device. Answers are
    // null after a skip; the "Call me" name is never stored here.
    onboardingCompleted: boolean("onboarding_completed").default(false).notNull(),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    onboardingAnswers: jsonb("onboarding_answers"),
    // Account-scoped model catalog preferences for Milestone 4 (favorites, hidden brands, brand order).
    catalogPreferences: jsonb("catalog_preferences").default({}).notNull(),
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
    // Projects only: use this project's memories in its chats, and save new ones to it (drizzle/0046).
    memoryUseEnabled: boolean("memory_use_enabled").default(true).notNull(),
    memorySaveEnabled: boolean("memory_save_enabled").default(true).notNull(),
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
    // The composer's "Use memory" switch. Null: not chosen, so the account setting decides. False: this conversation neither reads
    // nor saves memory. It never turns memory on when the account setting is off.
    useMemory: boolean("use_memory"),
    // A temporary chat: no memory used or saved, not listed, deleted after 24 hours (drizzle/0046).
    temporary: boolean("temporary").default(false).notNull(),
    ...timestamps,
  },
  (table) => [
    index("conversations_user_updated_idx").on(table.userId, table.updatedAt),
    index("conversations_owner_group_idx").on(table.userId, table.groupId),
    index("conversations_title_fts_idx").using("gin", sql`to_tsvector('english', ${table.title})`),
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
  (table) => [
    index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("messages_content_fts_idx").using("gin", sql`to_tsvector('english', ${table.content})`),
  ],
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
    // "personal" (the owner only) or "project" (one of the owner's projects, projectId). See drizzle/0046.
    scope: text("scope").default("personal").notNull(),
    projectId: uuid("project_id"),
    // "explicit" (asked to remember) or "inferred"; null on rows saved before 0046.
    origin: text("origin"),
    sourceConversationId: uuid("source_conversation_id"),
    ...timestamps,
  },
  (table) => [
    index("memory_facts_user_updated_idx").on(table.userId, table.updatedAt),
    index("memory_facts_user_scope_idx").on(table.userId, table.scope, table.projectId),
  ],
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

// Third-party model charges (Slice 7, drizzle/0048): one row per settled third-party call, so support can explain any charge.
export const marketplaceCharges = pgTable(
  "marketplace_charges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    usageEventId: uuid("usage_event_id").notNull().references(() => usageEvents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    rawCostMicros: integer("raw_cost_micros").notNull(),
    upchargeMicros: integer("upcharge_micros").notNull(),
    chargedMicros: integer("charged_micros").notNull(),
    credits: text("credits").notNull(),
    costSource: text("cost_source").notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("marketplace_charges_usage_event_unique").on(table.usageEventId),
    index("marketplace_charges_user_created_idx").on(table.userId, table.createdAt),
  ],
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

// Additive shadow cost ledger for Milestone 1: observes and records
// marked-up inference costs in micro-dollars without enforcing limits or
// modifying active quotas. Prompts and completions are strictly excluded.
export const shadowCostLedger = pgTable(
  "shadow_cost_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id"),
    requestId: text("request_id"),
    attemptNumber: integer("attempt_number").default(1).notNull(),
    operation: text("operation").notNull(),
    modality: text("modality").default("text").notNull(),
    modelKey: text("model_key").notNull(),
    provider: text("provider"),
    pricingVersionId: text("pricing_version_id").notNull(),
    pricingSource: text("pricing_source").notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    cachedInputTokens: integer("cached_input_tokens").default(0).notNull(),
    reasoningTokens: integer("reasoning_tokens").default(0).notNull(),
    rawCostMicros: integer("raw_cost_micros"),
    shadowDeductionMicros: integer("shadow_deduction_micros"),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    reservedCostMicros: integer("reserved_cost_micros").default(0).notNull(),
    settledCostMicros: integer("settled_cost_micros"),
    reservationExpiresAt: timestamp("reservation_expires_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    parentId: uuid("parent_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("shadow_cost_ledger_idempotency_unique").on(table.idempotencyKey),
    index("shadow_cost_ledger_user_created_idx").on(table.userId, table.createdAt),
    index("shadow_cost_ledger_request_idx").on(table.requestId),
    index("shadow_cost_ledger_status_idx").on(table.status),
    index("shadow_cost_ledger_user_expires_idx").on(table.userId, table.reservationExpiresAt),
    index("shadow_cost_ledger_lease_expires_idx").on(table.leaseExpiresAt),
    index("shadow_cost_ledger_parent_idx").on(table.parentId),
  ],
);

// Model Registry for Milestone 2A: internal, versioned catalog foundation.
// Decomposes stable model lineage, exact versions, endpoints, pricing, and privacy review.
// No credentials or user content are ever stored.

export const modelFamilies = pgTable(
  "model_families",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    familyGroup: text("family_group").notNull(),
    description: text("description").default("").notNull(),
    sortOrder: integer("sort_order").default(100).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("model_families_slug_unique").on(table.slug),
    index("model_families_group_idx").on(table.familyGroup),
  ],
);

export const modelVersions = pgTable(
  "model_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => modelFamilies.id, { onDelete: "cascade" }),
    versionTag: text("version_tag").notNull(),
    aliases: jsonb("aliases").default([]).notNull(),
    capabilitiesDocumented: jsonb("capabilities_documented").default({}).notNull(),
    planEligibility: text("plan_eligibility").default("paid").notNull(),
    lifecycleState: text("lifecycle_state").default("candidate").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("model_versions_family_version_unique").on(table.familyId, table.versionTag),
    index("model_versions_lifecycle_idx").on(table.lifecycleState),
  ],
);

export const modelEndpoints = pgTable(
  "model_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => modelVersions.id, { onDelete: "cascade" }),
    providerName: text("provider_name").notNull(),
    transportType: text("transport_type").notNull(),
    adapterType: text("adapter_type").default("chat_completions").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    capabilitiesVerified: jsonb("capabilities_verified").default({}).notNull(),
    privacyReview: jsonb("privacy_review").default({}).notNull(),
    endpointState: text("endpoint_state").default("candidate").notNull(),
    sortPriority: integer("sort_priority").default(10).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("model_endpoints_version_provider_transport_unique").on(
      table.versionId,
      table.providerName,
      table.transportType,
    ),
    index("model_endpoints_state_idx").on(table.endpointState),
  ],
);

export const modelPricingSnapshots = pgTable(
  "model_pricing_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => modelEndpoints.id, { onDelete: "cascade" }),
    pricingVersionId: text("pricing_version_id").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).defaultNow().notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    currency: text("currency").default("USD").notNull(),
    billingUnit: text("billing_unit").default("usd_per_1m_tokens").notNull(),
    inputPriceMicrosPerM: integer("input_price_micros_per_m"),
    outputPriceMicrosPerM: integer("output_price_micros_per_m"),
    cachedReadPriceMicrosPerM: integer("cached_read_price_micros_per_m"),
    reasoningPriceMicrosPerM: integer("reasoning_price_micros_per_m"),
    reasoningIncludedInOutput: boolean("reasoning_included_in_output").default(true).notNull(),
    calculatedMu: doublePrecision("calculated_mu"),
    consumptionCategory: text("consumption_category").default("pending").notNull(),
    pricingConfidence: text("pricing_confidence").default("unknown").notNull(),
    provenance: text("provenance").notNull(),
    ...timestamps,
  },
  (table) => [
    index("model_pricing_endpoint_effective_idx").on(table.endpointId, table.effectiveFrom),
    index("model_pricing_version_id_idx").on(table.pricingVersionId),
  ],
);




// One profile picture per account, already decoded and re-encoded by the server to a square 256px WebP with no metadata (see
// src/profile/picture.js), so what is stored is a few kilobytes. It lives in the database, not on the file volume, so deleting the
// account, exporting its data and backing it up all take it along with the rest. There is no user table to point at (Better Auth
// owns that), so ownership is the user id itself, and every query is by the signed-in user's id.
export const profilePictures = pgTable("profile_pictures", {
  userId: text("user_id").primaryKey(),
  contentType: text("content_type").default("image/webp").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  data: bytea("data").notNull(),
  ...timestamps,
});

// Per-user connected accounts for first-party plugins and productivity gateways.
// Tokens are tenant-scoped to the user ID and never shared across accounts.
export const userConnectors = pgTable(
  "user_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    status: text("status").default("disconnected").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    scopes: jsonb("scopes").default([]).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_connectors_user_provider_idx").on(table.userId, table.provider),
    index("user_connectors_user_status_idx").on(table.userId, table.status),
  ],
);

// Who owns which connected account (drizzle/0049, src/connectors/account-ownership.js): one row per Connect press and app, keyed by the
// unguessable alias given to the gateway; account_id is filled in once an account carrying that alias is listed. One account, one owner.
export const connectorAccountOwners = pgTable(
  "connector_account_owners",
  {
    alias: text("alias").primaryKey(),
    userId: text("user_id").notNull(),
    toolkit: text("toolkit").notNull(),
    app: text("app").notNull(),
    accountId: text("account_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("connector_account_owners_account_unique").on(table.accountId),
    index("connector_account_owners_user_idx").on(table.userId),
  ],
);

// Build's projects and their versions (drizzle/0052, src/build/projects.js). Files are stored as data and never executed.
export const buildProjects = pgTable(
  "build_projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    brief: text("brief").default("").notNull(),
    currentRevision: integer("current_revision").default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("build_projects_conversation_unique").on(table.conversationId),
    index("build_projects_user_idx").on(table.userId),
  ],
);
export const buildRevisions = pgTable(
  "build_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => buildProjects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    number: integer("number").notNull(),
    kind: text("kind").notNull(),
    entry: text("entry").notNull(),
    files: jsonb("files").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    messageId: uuid("message_id"),
    restoredFrom: integer("restored_from"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("build_revisions_project_number_unique").on(table.projectId, table.number),
    index("build_revisions_user_idx").on(table.userId),
  ],
);

// Human-in-the-Loop pending action approval ledger.
// Consequential write actions require explicit user approval with payload verification and short TTL.
export const pendingToolActions = pgTable(
  "pending_tool_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    conversationId: uuid("conversation_id"),
    toolName: text("tool_name").notNull(),
    actionDescription: text("action_description").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    result: jsonb("result"),
    ...timestamps,
  },
  (table) => [
    index("pending_tool_actions_user_status_idx").on(table.userId, table.status),
    uniqueIndex("pending_tool_actions_idempotency_idx").on(table.idempotencyKey),
  ],
);

// User-defined reusable skills with declarative workflow instructions and prerequisite tools.
export const userSkills = pgTable(
  "user_skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    instructions: text("instructions").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    requiredTools: jsonb("required_tools").default([]).notNull(),
    requiredConnectors: jsonb("required_connectors").default([]).notNull(),
    ...timestamps,
  },
  (table) => [
    index("user_skills_user_idx").on(table.userId),
  ],
);

