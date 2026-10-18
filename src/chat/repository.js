import { canonicalModelKey } from "../../frontend/src/token-quotas.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { attachments, conversations, messages } from "../db/schema.js";
import { removeFiles } from "../uploads/service.js";

const wholeSeconds = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function messageActivityMetadata(metadata) {
  return {
    sources: Array.isArray(metadata?.sources) ? metadata.sources : [],
    activitySummary: Array.isArray(metadata?.activitySummary) ? metadata.activitySummary : [],
    thoughtSeconds: wholeSeconds(metadata?.thoughtSeconds),
  };
}

// Only these fields are stored with a reply. The model's thinking text is
// shown live and never saved; how long it thought is the one thing kept.
export function assistantMessageMetadata({ sources = [], activitySummary = [], thoughtSeconds = null } = {}) {
  return {
    ...(sources.length ? { sources } : {}),
    ...(activitySummary.length ? { activitySummary } : {}),
    ...(wholeSeconds(thoughtSeconds) !== null ? { thoughtSeconds } : {}),
  };
}

export async function loadConversation(userId, conversationId) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);

  if (!conversation) return null;
  conversation.model = canonicalModelKey(conversation.model);

  // Bound provider context without accidentally preserving only the beginning
  // of a long conversation. A bulk exchange insert gives its user and
  // assistant rows the same PostgreSQL transaction timestamp, so make the
  // role tie-breaker explicit before restoring chronological order.
  const recentHistory = await db
    .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt, metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(desc(messages.createdAt), sql`case when ${messages.role} = 'assistant' then 0 else 1 end`)
    .limit(80);
  const history = recentHistory.reverse();
  const attachmentRows = await db
    .select({ id: attachments.id, messageId: attachments.messageId, originalName: attachments.originalName, mimeType: attachments.mimeType, kind: attachments.kind, sizeBytes: attachments.sizeBytes })
    .from(attachments)
    .where(eq(attachments.conversationId, conversation.id));
  const byMessage = new Map(attachmentRows.map((row) => [row.messageId, {
    id: row.id,
    name: row.originalName,
    mimeType: row.mimeType,
    kind: row.kind,
    sizeBytes: row.sizeBytes,
    downloadUrl: `/api/uploads/${row.id}/download`,
    previewUrl: row.kind === "generated-image" ? `/api/uploads/${row.id}/preview` : null,
  }]));
  for (const message of history) {
    message.attachment = byMessage.get(message.id) ?? null;
    // Surfaced as a plain array so the client renders a reloaded answer's
    // citations exactly the way it renders a freshly streamed one.
    const persisted = messageActivityMetadata(message.metadata);
    message.sources = persisted.sources;
    // This is deliberately a small, server-generated activity record, never
    // private reasoning. Keeping it with the message makes the disclosure
    // available after a reload just like sources.
    message.activitySummary = persisted.activitySummary;
    message.thoughtSeconds = persisted.thoughtSeconds;
    delete message.metadata;
  }

  return { conversation, history };
}

export async function listConversations(userId) {
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      model: conversations.model,
      mode: conversations.mode,
      groupId: conversations.groupId,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.archived, false)))
    .orderBy(desc(conversations.updatedAt))
    // Room for chats filed in projects and folders, which stay visible in
    // the sidebar however old they are.
    .limit(300);
  return rows.map((row) => ({ ...row, model: canonicalModelKey(row.model) }));
}

export async function renameConversation(userId, conversationId, title) {
  const name = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 120) return null;
  const [updated] = await db
    .update(conversations)
    .set({ title: name, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({
      id: conversations.id,
      title: conversations.title,
      model: conversations.model,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    });
  return updated ?? undefined;
}

// Model selection is part of a conversation's durable state, not only a
// client preference. Saving it separately means a user can switch models
// before sending the next message and still see the same model after reload.
export async function setConversationModel(userId, conversationId, model) {
  model = canonicalModelKey(model);
  const [updated] = await db
    .update(conversations)
    .set({ model, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({
      id: conversations.id,
      title: conversations.title,
      model: conversations.model,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    });
  return updated ?? undefined;
}

// Deleting a chat deletes its uploaded and generated files too. The rows go
// with the conversation (cascade); the stored bytes are removed here, after
// the delete commits, so a failed delete never loses a file.
export async function deleteConversation(userId, conversationId) {
  const files = await db
    .select({ storedName: attachments.storedName })
    .from(attachments)
    .where(and(eq(attachments.conversationId, conversationId), eq(attachments.userId, userId)));
  const deleted = await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({ id: conversations.id });
  if (deleted.length && files.length) await removeFiles(files);
  return deleted.length > 0;
}

export function makeTitle(content) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
}

// The user's message, saved as soon as a chat request is accepted, before any
// reply is made. A reply that fails or is interrupted then never takes the
// message with it. A first message creates its conversation here. A retry of
// the conversation's last message, still unanswered, reuses that message
// instead of adding it again.
export async function saveUserMessage({ userId, conversationId, modelKey, content, mode }) {
  modelKey = canonicalModelKey(modelKey);
  return db.transaction(async (tx) => {
    let id = conversationId;
    if (!id) {
      const [created] = await tx
        .insert(conversations)
        .values({ userId, title: makeTitle(content), model: modelKey, ...(mode ? { mode } : {}) })
        .returning({ id: conversations.id });
      id = created.id;
    } else {
      const [last] = await tx
        .select({ id: messages.id, role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(desc(messages.createdAt), sql`case when ${messages.role} = 'assistant' then 0 else 1 end`)
        .limit(1);
      if (last?.role === "user" && last.content === content) {
        await tx.update(messages).set({ metadata: {} }).where(eq(messages.id, last.id));
        return { conversationId: id, messageId: last.id, reused: true };
      }
    }
    const [saved] = await tx
      .insert(messages)
      .values({ conversationId: id, role: "user", content, createdAt: new Date() })
      .returning({ id: messages.id });
    return { conversationId: id, messageId: saved.id, reused: false };
  });
}

// Marks a saved user message whose reply never arrived: "failed" or
// "interrupted" (the user left), with the request's reference id. The message
// itself is kept. A message that was answered after all (a step after the
// reply was saved failed) is left alone.
export async function markReplyMissing(messageId, replyStatus, requestId) {
  await db.update(messages)
    .set({ metadata: { replyStatus, requestId } })
    .where(and(eq(messages.id, messageId), sql`not exists (
      select 1 from messages answer
      where answer.conversation_id = messages.conversation_id and answer.role = 'assistant' and answer.created_at > messages.created_at
    )`));
}

// Saves a finished exchange. With userMessageId, the user's message was
// already saved by saveUserMessage: only the reply is added (and the
// message's missing-reply mark cleared). Without it, both are saved together.
export async function saveExchange({ userId, conversationId, modelKey, userContent, reply, attachmentIds = [], mode, sources = [], activitySummary = [], thoughtSeconds = null, userMessageId = null }) {
  modelKey = canonicalModelKey(modelKey);
  return db.transaction(async (tx) => {
    let id = conversationId;

    if (!id) {
      const [created] = await tx
        .insert(conversations)
        .values({
          userId,
          title: makeTitle(userContent),
          model: modelKey,
          // Set mode only on creation. Existing conversations retain their
          // mode even if a client sends a different workspace flag.
          ...(mode ? { mode } : {}),
        })
        .returning({ id: conversations.id });
      id = created.id;
    } else {
      await tx
        .update(conversations)
        .set({ model: modelKey, title: sql`case when ${conversations.mode} = 'study' and ${conversations.title} = 'Study session' then ${makeTitle(userContent)} else ${conversations.title} end`, updatedAt: new Date() })
        .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
    }

    // PostgreSQL's now() is stable for a whole transaction. Assigning a tiny
    // explicit offset keeps each exchange sortable for both the UI and prompt
    // history, rather than relying on arbitrary order for equal timestamps.
    const userCreatedAt = new Date();
    const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
    const assistantMetadata = assistantMessageMetadata({ sources, activitySummary, thoughtSeconds });
    // Sources ride along in the assistant row's metadata so a reloaded
    // conversation can still show what an answer was grounded in. They
    // were previously returned on the live response only, which meant
    // every citation vanished the moment the page was refreshed.
    const assistantRow = { conversationId: id, role: "assistant", content: reply, createdAt: assistantCreatedAt, ...(Object.keys(assistantMetadata).length ? { metadata: assistantMetadata } : {}) };
    let saved;
    if (userMessageId) {
      const [userRow] = await tx
        .update(messages)
        .set({ metadata: {} })
        .where(and(eq(messages.id, userMessageId), eq(messages.conversationId, id)))
        .returning({ id: messages.id, role: messages.role, content: messages.content });
      if (!userRow) throw new Error("The message being answered is no longer in this conversation.");
      const [assistant] = await tx.insert(messages).values(assistantRow).returning({ id: messages.id, role: messages.role, content: messages.content });
      saved = [userRow, assistant];
    } else {
      saved = await tx
        .insert(messages)
        .values([{ conversationId: id, role: "user", content: userContent, createdAt: userCreatedAt }, assistantRow])
        .returning({ id: messages.id, role: messages.role, content: messages.content });
    }

    if (attachmentIds.length) {
      await tx
        .update(attachments)
        .set({ conversationId: id, messageId: saved[0].id, updatedAt: new Date() })
        .where(and(eq(attachments.userId, userId), eq(attachments.id, attachmentIds[0])));

      // Drizzle's lightweight query builder does not offer a portable UUID
      // array predicate in this project version, so update the remaining ids
      // individually inside the same transaction.
      for (const attachmentId of attachmentIds.slice(1)) {
        await tx
          .update(attachments)
          .set({ conversationId: id, messageId: saved[0].id, updatedAt: new Date() })
          .where(and(eq(attachments.userId, userId), eq(attachments.id, attachmentId)));
      }
    }

    return { conversationId: id, messages: saved };
  });
}

// Appends a Comet voice call's transcript to the same thread the call was
// started from (creating one, exactly like a first text message would, when
// none was open yet). Each speech segment becomes its own message in
// chronological order, tagged `metadata.source: "voice"`, rather than being
// squashed into a single user/assistant pair — a call can be a real
// back-and-forth, and the thread should read that way.
export async function saveVoiceTranscript({ userId, conversationId, modelKey, segments }) {
  const cleaned = (segments ?? [])
    .map((segment) => ({ role: segment.role === "comet" ? "assistant" : "user", content: String(segment.text ?? "").trim() }))
    .filter((segment) => segment.content);
  if (!cleaned.length) return null;

  return db.transaction(async (tx) => {
    let id = conversationId;
    if (!id) {
      const firstUserLine = cleaned.find((segment) => segment.role === "user");
      const [created] = await tx
        .insert(conversations)
        .values({ userId, title: firstUserLine ? makeTitle(firstUserLine.content) : "Voice call with Comet", model: modelKey })
        .returning({ id: conversations.id });
      id = created.id;
    } else {
      await tx.update(conversations).set({ updatedAt: new Date() }).where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
    }

    // Same stable-ordering trick as saveExchange: one transaction shares a
    // single now(), so give each row its own tiny explicit offset.
    const base = Date.now();
    const rows = cleaned.map((segment, index) => ({
      conversationId: id,
      role: segment.role,
      content: segment.content,
      metadata: { source: "voice" },
      createdAt: new Date(base + index),
    }));
    const saved = await tx.insert(messages).values(rows).returning({ id: messages.id, role: messages.role, content: messages.content });
    return { conversationId: id, messages: saved };
  });
}

// A single request that produces multiple results (for example several image
// variations) should read as one user turn, not a repeated one. Callers save
// the user turn once with saveExchange, then add each further assistant
// reply here.
export async function addAssistantReply({ userId, conversationId, reply }) {
  const [saved] = await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({ id: conversations.id });
  if (!saved) throw Object.assign(new Error("Conversation not found."), { status: 404 });
  const [message] = await db
    .insert(messages)
    .values({ conversationId, role: "assistant", content: reply })
    .returning({ id: messages.id, role: messages.role, content: messages.content });
  return { conversationId, messages: [message] };
}
