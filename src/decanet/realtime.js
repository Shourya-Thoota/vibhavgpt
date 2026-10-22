import { EVENT_FORMATS, findEvent } from "./events.js";
import { decanetConfig, DecanetError } from "./config.js";

// Short judge turns keep the role-play realistic (the participant does most
// of the talking) and keep audio output, the expensive part, small.
export const MAX_JUDGE_OUTPUT_TOKENS = 450;

// Whisper-style transcription keeps disfluencies when its prompt contains
// them, so the grader can see the participant's real filler words.
export const FILLER_PROMPT = "Um, so, uh, I think, like, you know, we should, um, basically... Hmm, okay. So, uh, yeah.";

export function judgeInstructions(roleplay, { priorTranscript = [] } = {}) {
  const event = findEvent(roleplay.eventCode);
  const format = EVENT_FORMATS[event.format];
  const audience = format.team ? "a team of DECA competitors (one person will speak for the team)" : "a DECA competitor";
  const lines = [
    `You are ${roleplay.judge.name}, the ${roleplay.judge.role} of ${roleplay.company}. You are meeting ${audience}, who is playing the role of your ${roleplay.participantRole}. Stay fully in character as ${roleplay.judge.name} for the entire conversation.`,
    "",
    "THE SITUATION (the participant has read this and prepared a response):",
    ...roleplay.situation,
    "",
    "YOUR CHARACTER:",
    roleplay.characterization,
    "",
    "HOW TO BEHAVE:",
    "- This is the participant's presentation. Mostly listen. They should do nearly all of the talking.",
    "- Speak only when a stage direction tells you to. Follow each stage direction exactly, then stop.",
    "- Keep every turn short: one to three sentences, never more than about fifteen seconds of speech.",
    "- Sound like a real, busy professional: natural, warm but businesslike, in clear American English. React to what they actually said.",
    "- If the participant asks you something, answer briefly in character. You may invent small, plausible details that fit the situation.",
    "- Never coach, hint, praise their answers in detail, evaluate them or give feedback. Never mention scores, rubrics, performance indicators, DECA judging, AI or that this is practice.",
    "- Do not ask questions of your own except the prepared questions below, and only when told.",
    "",
    "YOUR PREPARED QUESTIONS (ask them only when a stage direction tells you to, in your own natural words):",
    `1. ${roleplay.questions[0]}`,
    `2. ${roleplay.questions[1]}`,
  ];
  if (priorTranscript.length) {
    lines.push("", "THE CONVERSATION SO FAR (the call reconnected; continue naturally without greeting again):");
    for (const segment of priorTranscript.slice(-40)) lines.push(`${segment.speaker === "judge" ? "You" : "Participant"}: ${segment.text}`);
  }
  return lines.join("\n");
}

export function sessionConfig(roleplay, options = {}) {
  return {
    type: "realtime",
    model: decanetConfig.realtimeModel,
    instructions: judgeInstructions(roleplay, options),
    output_modalities: ["audio"],
    max_output_tokens: MAX_JUDGE_OUTPUT_TOKENS,
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        transcription: { model: decanetConfig.transcriptionModel, language: "en", prompt: FILLER_PROMPT },
        // The browser decides when the judge speaks (stage directions), so the
        // model never answers every pause on its own.
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700, create_response: false, interrupt_response: true },
      },
      output: { voice: roleplay.judge.voice },
    },
  };
}

// Server-side WebRTC exchange: the browser sends its offer here, the API key
// never leaves the server, and the browser gets only the answer SDP.
export async function createRealtimeCall(roleplay, offerSdp, options = {}, { fetchImpl = fetch } = {}) {
  if (!decanetConfig.openaiApiKey) throw new DecanetError(503, "Role-plays aren't configured yet. Please try again later.");
  if (typeof offerSdp !== "string" || !offerSdp.startsWith("v=") || offerSdp.length > 20_000) throw new DecanetError(400, "Invalid audio connection offer.");
  const form = new FormData();
  form.set("sdp", offerSdp);
  form.set("session", JSON.stringify(sessionConfig(roleplay, options)));
  const response = await fetchImpl(`${decanetConfig.openaiBaseUrl}/realtime/calls`, {
    method: "POST", headers: { Authorization: `Bearer ${decanetConfig.openaiApiKey}` }, body: form, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    console.error("decanet.realtime.call_failed", { status: response.status, code: String(payload?.error?.code ?? "").slice(0, 80), param: String(payload?.error?.param ?? "").slice(0, 100) });
    throw new DecanetError(502, "We couldn't connect you to the judge. Please try again.");
  }
  const sdp = await response.text();
  const location = response.headers.get("location") ?? "";
  const callId = location.split("/").filter(Boolean).pop() || null;
  if (!sdp.trim()) throw new DecanetError(502, "We couldn't connect you to the judge. Please try again.");
  return { sdp, callId };
}

export async function hangUpRealtimeCall(callId, { fetchImpl = fetch } = {}) {
  if (!callId || !decanetConfig.openaiApiKey) return false;
  try {
    const response = await fetchImpl(`${decanetConfig.openaiBaseUrl}/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST", headers: { Authorization: `Bearer ${decanetConfig.openaiApiKey}` }, signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// A hard stop: whatever the browser does, the call is hung up shortly after
// the role-play's time runs out, so no session can run up an open-ended bill.
const scheduled = new Map();
export function scheduleHangUp(callId, seconds, hangUp = hangUpRealtimeCall) {
  if (!callId) return;
  clearTimeout(scheduled.get(callId));
  const timer = setTimeout(() => { scheduled.delete(callId); void hangUp(callId); }, Math.max(1, seconds) * 1000);
  timer.unref?.();
  scheduled.set(callId, timer);
}
export function cancelScheduledHangUp(callId) {
  clearTimeout(scheduled.get(callId));
  scheduled.delete(callId);
}

const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(Number(value), 50_000_000) : 0);

// Usage as reported by the browser from each response.done and transcription
// event, summed. Used for the cost estimate in logs and the attempt record.
export function sanitizeUsage(value) {
  const usage = value && typeof value === "object" ? value : {};
  return {
    audioIn: count(usage.audioIn), audioInCached: count(usage.audioInCached), audioOut: count(usage.audioOut),
    textIn: count(usage.textIn), textInCached: count(usage.textInCached), textOut: count(usage.textOut),
    transcriptionSeconds: count(usage.transcriptionSeconds), responses: count(usage.responses),
  };
}

export function estimateCostCents(usage, prices = decanetConfig.prices) {
  const dollars = (usage.audioIn * prices.audioIn + usage.audioInCached * prices.audioInCached + usage.audioOut * prices.audioOut
    + usage.textIn * prices.textIn + usage.textInCached * prices.textInCached + usage.textOut * prices.textOut) / 1_000_000
    + (usage.transcriptionSeconds / 60) * 0.003;
  return Math.round(dollars * 1000) / 10;
}
