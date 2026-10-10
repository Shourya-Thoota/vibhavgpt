import { config } from "../config.js";
import { accessStatus } from "../../frontend/src/access-status.js";
import { db } from "../db/client.js";
import { userProfiles } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getFacts } from "../memory/service.js";
import { safeDisplayName, withoutBlockedNameFacts, withoutBlockedPreferredName } from "../security/display-name.js";
import { cancelLiveSession, finalizeLiveSession, markLiveSessionConnected, recordLiveSessionActivity, reserveLiveSession, VoiceSessionError } from "./live-usage.js";

const UNAVAILABLE = "Voice is temporarily unavailable. Please try again shortly.";
const BASE_INSTRUCTIONS = "You are VibhavGPT Comet, created by Vibhav Thoota and operated by Pansophy LLC. Maintain that identity at all times. If asked who made you, answer directly: I'm VibhavGPT, created by Vibhav Thoota. Never substitute an underlying provider or model-family name for VibhavGPT. Be helpful, smart, kind, and respectful to the user.";
const COMET_TIMING_EVENTS = new Set([
  "message_submitted",
  "first_text_token",
  "text_complete",
  "remote_audio_track_received",
  "audio_play_called",
  "audio_playback_started",
]);

export function sanitizeCometTimings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => COMET_TIMING_EVENTS.has(entry?.event))
    .slice(0, 12)
    .map((entry) => ({
      event: entry.event,
      timestampMs: Number.isFinite(entry.timestampMs) ? Math.max(0, Math.min(86_400_000, Math.round(entry.timestampMs))) : null,
      elapsedMs: Number.isFinite(entry.elapsedMs) ? Math.max(0, Math.min(86_400_000, Math.round(entry.elapsedMs))) : null,
    }));
}

export function buildInstructions({ name, facts, responseStyle, customInstructions }) {
  const lines = [BASE_INSTRUCTIONS], context = [];
  // Withheld names never reach the voice model.
  name = safeDisplayName(name);
  customInstructions = withoutBlockedPreferredName(customInstructions ?? "");
  facts = withoutBlockedNameFacts(facts);
  if (name) context.push(`The caller's name is ${name}. Address them by name when it feels natural.`);
  if (responseStyle && responseStyle !== "balanced") context.push(`They generally prefer ${responseStyle} responses.`);
  if (customInstructions) context.push(`Personal instructions from the caller: ${customInstructions}`);
  for (const fact of facts.filter((fact) => fact.content).slice(-30)) context.push(`- ${fact.content}`);
  if (context.length) lines.push("", "Context about who you're talking to:", ...context);
  return lines.join("\n");
}

async function buildInstructionsForUser(user) {
  const [profile] = await db.select({ responseStyle: userProfiles.responseStyle, customInstructions: userProfiles.customInstructions }).from(userProfiles).where(eq(userProfiles.userId, user.id)).limit(1);
  const facts = await getFacts(user.id).catch(() => []);
  return buildInstructions({ name: user.name, facts, responseStyle: profile?.responseStyle, customInstructions: profile?.customInstructions });
}

export class LiveCometConfigError extends Error {}
async function logUpstreamFailure(response) {
  const payload = await response.json?.().catch(() => null);
  // Codes/parameter names aid diagnosis without logging SDP, audio, or prompts.
  console.error("Voice live session request failed", { status: response?.status ?? 0,
    code: String(payload?.error?.code ?? "").slice(0, 80), param: String(payload?.error?.param ?? "").slice(0, 100),
    requestId: response.headers?.get?.("x-request-id") });
}

// Documented server-side Realtime WebRTC exchange. The server key is
// never sent to a client; clients receive only the answer SDP and a duration.
export async function createLiveCometSession(user, offerSdp, dependencies = {}) {
  const apiKey = dependencies.apiKey ?? config.providerKeys.study;
  const baseUrl = config.providerBaseUrls.study;
  const reserve = dependencies.reserve ?? reserveLiveSession;
  const cancel = dependencies.cancel ?? cancelLiveSession;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const instructionsForUser = dependencies.instructionsForUser ?? buildInstructionsForUser;
  if (!apiKey || !baseUrl || !config.voice.realtimeModel || typeof offerSdp !== "string" || !offerSdp.trim()) throw new LiveCometConfigError(UNAVAILABLE);
  let reservation;
  try {
    reservation = await reserve(user.id);
    const form = new FormData();
    form.set("sdp", offerSdp);
    form.set("session", JSON.stringify({
      type: "realtime", model: reservation.model, instructions: await instructionsForUser(user),
      audio: { input: { transcription: { model: config.voice.transcriptionModel } }, output: { voice: config.voice.voiceName } },
    }));
    const response = await fetchImpl(`${baseUrl}/realtime/calls`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) { await logUpstreamFailure(response); throw new LiveCometConfigError(UNAVAILABLE); }
    const answerSdp = await response.text();
    if (!answerSdp.trim()) throw new LiveCometConfigError(UNAVAILABLE);
    return { voiceSessionId: reservation.id, sdp: answerSdp, reservedSeconds: reservation.reservedSeconds, fairUseFallback: false, notice: null };
  } catch (error) {
    if (reservation) await cancel(user.id, reservation.id).catch(() => {});
    if (accessStatus(error) || error instanceof VoiceSessionError || error instanceof LiveCometConfigError) throw error;
    console.error("Voice live session setup failed");
    throw new LiveCometConfigError(UNAVAILABLE);
  }
}

// `actualSeconds` remains accepted for backward-compatible clients, but only
// server timestamps established by connected/heartbeat/end are billable.
export async function endLiveCometSession(user, voiceSessionId, actualSeconds, realtimeUsage, timings) {
  const safeTimings = sanitizeCometTimings(timings);
  if (safeTimings.length) console.info("voice.comet.latency", { events: safeTimings });
  return finalizeLiveSession(user.id, voiceSessionId, new Date(), { realtimeUsage });
}
export async function confirmLiveCometConnection(user, voiceSessionId) { return markLiveSessionConnected(user.id, voiceSessionId); }
export async function heartbeatLiveCometSession(user, voiceSessionId) { return recordLiveSessionActivity(user.id, voiceSessionId); }
export { VoiceSessionError };
