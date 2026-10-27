import express, { Router } from "express";
import { requireSession } from "../middleware/require-session.js";
import { confirmLiveCometConnection, endLiveCometSession, heartbeatLiveCometSession } from "./live-comet.js";
import { loadConversation, saveVoiceTranscript } from "../chat/repository.js";
import { normalizeModelKey, UUID_PATTERN } from "../chat/router.js";

export const voiceRouter = Router();

// Each route reads only the body it needs, with a limit sized to it. connected and heartbeat read
// no body at all; end carries a handful of token counts and at most twelve timing entries (about 2 KB);
// a transcript is text from a call capped at 15 minutes (tens of KB). Nothing here may take the
// 28 MB that audio uploads once needed. The small routes parse first because 16 KB costs nothing;
// the transcript route authenticates first, so only a signed-in caller can make it read up to 256 KB.
export const SETTLEMENT_JSON_LIMIT = "16kb";
export const TRANSCRIPT_JSON_LIMIT = "256kb";
const settlementJson = express.json({ limit: SETTLEMENT_JSON_LIMIT });
const transcriptJson = express.json({ limit: TRANSCRIPT_JSON_LIMIT });

// Voice (dictation and Live Comet calls) has been removed from VibhavGPT.
// Nothing can start a new voice session: both entry points answer 410 before
// any usage is reserved or any provider is called, so no voice credit or
// allowance can be spent. The lifecycle routes below stay only so a call that
// was already connected when this shipped can end and settle its reservation
// (unconnected reservations are refunded by the reconciliation job), and its
// transcript can land in the chat it belongs to. Past voice chats remain in
// history as ordinary conversations.
// server.js answers the same two paths first, ahead of the JSON parser; this copy keeps the
// router correct if it is ever mounted without that.
export const VOICE_REMOVED = { error: "Voice is no longer available in VibhavGPT.", code: "voice-removed" };
voiceRouter.post(["/transcribe", "/live/session"], (req, res) => res.status(410).json(VOICE_REMOVED));

// A reservation becomes billable only once the caller's WebRTC peer is
// actually connected. Both lifecycle calls are authenticated and idempotent.
voiceRouter.post("/live/session/:id/connected", settlementJson, requireSession, async (req, res, next) => {
  try {
    const confirmed = await confirmLiveCometConnection(req.authSession.user, req.params.id);
    if (!confirmed) return res.status(404).json({ error: "Voice session not found." });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

voiceRouter.post("/live/session/:id/heartbeat", settlementJson, requireSession, async (req, res, next) => {
  try {
    const active = await heartbeatLiveCometSession(req.authSession.user, req.params.id);
    if (!active) return res.status(404).json({ error: "Voice session not found." });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// Sent on a clean hangup and as a best-effort beacon on tab close. The client
// duration is informational only; billing uses server-recorded connection and
// activity timestamps. Unconnected reservations are refunded by reconciliation.
voiceRouter.post("/live/session/:id/end", settlementJson, requireSession, async (req, res, next) => {
  try {
    const actualSeconds = Number(req.body?.actualSeconds);
    if (!Number.isFinite(actualSeconds) || actualSeconds < 0) return res.status(400).json({ error: "A valid actualSeconds is required." });
    const updated = await endLiveCometSession(req.authSession.user, req.params.id, actualSeconds, req.body?.realtimeUsage, req.body?.timings);
    if (!updated) return res.status(404).json({ error: "Voice session not found." });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// Appends the call's transcript into the conversation thread that was open
// when the call started (or creates one, same as a first text message
// would). Separate from /end above: that endpoint reconciles billed
// duration, this one is purely about chat history.
voiceRouter.post("/live/session/:id/transcript", requireSession, transcriptJson, async (req, res, next) => {
  try {
    const userId = req.authSession.user.id;
    const conversationId = req.body?.conversationId || null;
    if (conversationId && (typeof conversationId !== "string" || !UUID_PATTERN.test(conversationId))) {
      return res.status(400).json({ error: "Invalid conversation." });
    }
    if (conversationId && !(await loadConversation(userId, conversationId))) {
      return res.status(404).json({ error: "Conversation not found." });
    }
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const saved = await saveVoiceTranscript({ userId, conversationId, modelKey: normalizeModelKey(req.body?.modelKey), segments });
    return res.json({ conversationId: saved?.conversationId ?? conversationId ?? null });
  } catch (error) {
    return next(error);
  }
});
