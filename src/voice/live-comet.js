import { safeDisplayName, withoutBlockedNameFacts, withoutBlockedPreferredName } from "../security/display-name.js";
import { finalizeLiveSession, markLiveSessionConnected, recordLiveSessionActivity } from "./live-usage.js";

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

// `actualSeconds` remains accepted for backward-compatible clients, but only
// server timestamps established by connected/heartbeat/end are billable.
export async function endLiveCometSession(user, voiceSessionId, actualSeconds, realtimeUsage, timings) {
  const safeTimings = sanitizeCometTimings(timings);
  if (safeTimings.length) console.info("voice.comet.latency", { events: safeTimings });
  return finalizeLiveSession(user.id, voiceSessionId, new Date(), { realtimeUsage });
}
export async function confirmLiveCometConnection(user, voiceSessionId) { return markLiveSessionConnected(user.id, voiceSessionId); }
export async function heartbeatLiveCometSession(user, voiceSessionId) { return recordLiveSessionActivity(user.id, voiceSessionId); }
