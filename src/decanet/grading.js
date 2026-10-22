import { CENTURY_SKILLS, EVENT_FORMATS, SKILL_MAX, findEvent } from "./events.js";
import { decanetConfig, DecanetError } from "./config.js";
import { ratingBands, ratingFor } from "./catalog.js";

// Fillers counted in the participant's speech. "like" and "so" are also
// ordinary words, so they are counted only where they usually act as fillers.
const FILLERS = [
  ["um", /\b(?:um+|umm+|erm)\b/gi],
  ["uh", /\b(?:uh+|uhh+|er|ah+)\b/gi],
  ["like", /(?:^|[,.!?]\s*|\b(?:was|is|it's|and|but|just|it|i'm|i)\s+)like\b(?!\s+(?:to|that|this|a|an|the)\b)/gi],
  ["you know", /\byou know\b(?!\s+(?:what|how|that|why|when))/gi],
  ["basically", /\bbasically\b/gi],
  ["literally", /\bliterally\b/gi],
  ["kind of / sort of", /\b(?:kind|sort) of\b/gi],
  ["I mean", /\bi mean\b/gi],
  ["so (to start)", /(?:^|[.!?]\s+)so\b/gi],
];

export function analyzeDelivery(segments, durationSeconds) {
  const participant = segments.filter((segment) => segment.speaker === "participant").map((segment) => segment.text).join(" ");
  const words = participant.split(/\s+/).filter(Boolean).length;
  const fillers = {};
  let total = 0;
  for (const [label, pattern] of FILLERS) {
    const count = (participant.match(pattern) ?? []).length;
    if (count) fillers[label] = count;
    total += count;
  }
  const minutes = Math.max(durationSeconds, 1) / 60;
  return {
    words,
    wordsPerMinute: Math.round(words / minutes),
    fillers,
    fillerTotal: total,
    fillersPerMinute: Math.round((total / minutes) * 10) / 10,
    participantTurns: segments.filter((segment) => segment.speaker === "participant").length,
    judgeTurns: segments.filter((segment) => segment.speaker === "judge").length,
  };
}

export function transcriptText(segments) {
  return segments.map((segment) => {
    const at = Math.max(0, Math.round(segment.t ?? 0));
    const stamp = `${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`;
    return `[${stamp}] ${segment.speaker === "judge" ? "JUDGE" : "PARTICIPANT"}: ${segment.text}`;
  }).join("\n");
}

export function gradingSchema(piCount) {
  const string = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["performance_indicators", "century_skills", "judge_questions", "strengths", "improvements", "delivery", "summary"],
    properties: {
      performance_indicators: {
        type: "array", minItems: piCount, maxItems: piCount,
        items: { type: "object", additionalProperties: false, required: ["index", "score", "evidence", "feedback", "improvement"],
          properties: { index: { type: "integer" }, score: { type: "integer" }, evidence: string, feedback: string, improvement: string } },
      },
      century_skills: {
        type: "array", minItems: CENTURY_SKILLS.length, maxItems: CENTURY_SKILLS.length,
        items: { type: "object", additionalProperties: false, required: ["key", "score", "feedback"],
          properties: { key: { type: "string", enum: CENTURY_SKILLS.map((skill) => skill.key) }, score: { type: "integer" }, feedback: string } },
      },
      judge_questions: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["question", "answered", "feedback"],
          properties: { question: string, answered: { type: "boolean" }, feedback: string } },
      },
      strengths: { type: "array", items: string },
      improvements: { type: "array", items: string },
      delivery: { type: "object", additionalProperties: false, required: ["filler_feedback", "pacing_feedback", "professionalism_feedback"],
        properties: { filler_feedback: string, pacing_feedback: string, professionalism_feedback: string } },
      summary: string,
    },
  };
}

export function gradingPrompt({ roleplay, notes, segments, delivery, durationSeconds }) {
  const event = findEvent(roleplay.eventCode);
  const format = EVENT_FORMATS[event.format];
  const bands = (max) => ratingBands(max).map(([label, low, high]) => `${label} ${low}-${high}`).join("; ");
  const system = [
    "You are an experienced, fair DECA competitive events judge and coach. You score role-plays strictly against the official-style rubric and give specific, encouraging, actionable feedback to a high school competitor.",
    "Score only what the participant actually said in the transcript. Do not give credit for ideas that appear only in their notes. A performance indicator the participant never addressed scores in the Little/No Value band.",
    "Quote or closely paraphrase the participant's words as evidence. Feedback speaks to the participant as 'you'. No em dashes.",
    "The transcript comes from speech recognition, so ignore obvious transcription errors in spelling, but do treat filler words (um, uh, like, you know) as real.",
  ].join(" ");
  const user = [
    `EVENT: ${event.name} (${event.code}), ${format.team ? "Team Decision Making case study" : "role-play"}, instructional area: ${roleplay.instructionalArea}.`,
    `TIME LIMIT: ${format.roleplaySeconds / 60} minutes. ACTUAL LENGTH: ${Math.round(durationSeconds / 6) / 10} minutes.`,
    "",
    `PARTICIPANT ROLE: ${roleplay.participantRole} at ${roleplay.company}.`,
    "SITUATION THE PARTICIPANT READ:",
    ...roleplay.situation,
    "",
    `JUDGE: ${roleplay.judge.name}, ${roleplay.judge.role}. ${roleplay.characterization}`,
    `JUDGE'S PREPARED QUESTIONS: 1) ${roleplay.questions[0]} 2) ${roleplay.questions[1]}`,
    "",
    `PERFORMANCE INDICATORS (each scored 0-${format.piMax}; bands: ${bands(format.piMax)}):`,
    ...roleplay.performanceIndicators.map((text, index) => `${index}. ${text}`),
    "",
    `21ST CENTURY SKILLS (each scored 0-${SKILL_MAX}; bands: ${bands(SKILL_MAX)}):`,
    ...CENTURY_SKILLS.map((skill) => `${skill.key}: ${skill.label}. ${skill.detail}`),
    "",
    "DELIVERY MEASUREMENTS (computed from the transcript):",
    JSON.stringify(delivery),
    "",
    "PARTICIPANT'S PREP NOTES (context only, never scored):",
    notes?.trim() ? notes.slice(0, 6000) : "(none)",
    "",
    "FULL TRANSCRIPT:",
    transcriptText(segments) || "(empty)",
    "",
    "Return the JSON. performance_indicators must have one entry per indicator, index 0 to " + (format.piCount - 1) + ", in order. For judge_questions, list each question the judge actually asked and how well it was answered. Give 2-4 strengths and 2-4 improvements, most important first. The summary is 2-3 sentences.",
  ].join("\n");
  return { system, user };
}

const clamp = (value, max) => Math.max(0, Math.min(max, Math.round(Number(value) || 0)));

// Turns the grader's JSON into the stored result: scores are clamped to the
// rubric, every indicator and skill is present, and the total is recomputed
// here rather than trusted from the model.
export function buildResult(roleplay, graded, delivery) {
  const format = EVENT_FORMATS[roleplay.format];
  const byIndex = new Map((graded?.performance_indicators ?? []).map((entry) => [Number(entry.index), entry]));
  const performanceIndicators = roleplay.performanceIndicators.map((text, index) => {
    const entry = byIndex.get(index) ?? {};
    const score = clamp(entry.score, format.piMax);
    return { index, text, score, max: format.piMax, rating: ratingFor(score, format.piMax), evidence: String(entry.evidence ?? ""), feedback: String(entry.feedback ?? ""), improvement: String(entry.improvement ?? "") };
  });
  const byKey = new Map((graded?.century_skills ?? []).map((entry) => [entry.key, entry]));
  const skills = CENTURY_SKILLS.map((skill) => {
    const entry = byKey.get(skill.key) ?? {};
    const score = clamp(entry.score, SKILL_MAX);
    return { key: skill.key, label: skill.label, detail: skill.detail, score, max: SKILL_MAX, rating: ratingFor(score, SKILL_MAX), feedback: String(entry.feedback ?? "") };
  });
  const piTotal = performanceIndicators.reduce((sum, entry) => sum + entry.score, 0);
  const skillTotal = skills.reduce((sum, entry) => sum + entry.score, 0);
  const list = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 6) : []);
  return {
    total: piTotal + skillTotal,
    max: format.piCount * format.piMax + CENTURY_SKILLS.length * SKILL_MAX,
    performanceIndicatorTotal: piTotal,
    skillTotal,
    performanceIndicators,
    skills,
    judgeQuestions: (graded?.judge_questions ?? []).slice(0, 4).map((entry) => ({ question: String(entry.question ?? ""), answered: Boolean(entry.answered), feedback: String(entry.feedback ?? "") })),
    strengths: list(graded?.strengths),
    improvements: list(graded?.improvements),
    delivery: {
      ...delivery,
      fillerFeedback: String(graded?.delivery?.filler_feedback ?? ""),
      pacingFeedback: String(graded?.delivery?.pacing_feedback ?? ""),
      professionalismFeedback: String(graded?.delivery?.professionalism_feedback ?? ""),
    },
    summary: String(graded?.summary ?? ""),
  };
}

// Too little was said to judge: score it without calling the model.
export function emptyResult(roleplay, delivery) {
  const result = buildResult(roleplay, null, delivery);
  return {
    ...result,
    summary: "We couldn't hear enough of a presentation to score it. Check that your microphone is allowed and working, then try a role-play again.",
    improvements: ["Make sure your microphone is connected and DECANet has permission to use it.", "Speak for most of your time: present your ideas and address every performance indicator."],
    delivery: { ...result.delivery, fillerFeedback: "Not enough speech was captured to review filler words.", pacingFeedback: "", professionalismFeedback: "" },
  };
}

export async function gradeWithModel({ roleplay, notes, segments, durationSeconds }, { fetchImpl = fetch } = {}) {
  const delivery = analyzeDelivery(segments, durationSeconds);
  if (delivery.words < 25) return emptyResult(roleplay, delivery);
  if (!decanetConfig.openaiApiKey) throw new DecanetError(503, "Grading isn't configured yet.");
  const format = EVENT_FORMATS[roleplay.format];
  const { system, user } = gradingPrompt({ roleplay, notes, segments, delivery, durationSeconds });
  const response = await fetchImpl(`${decanetConfig.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${decanetConfig.openaiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: decanetConfig.graderModel,
      reasoning_effort: "medium",
      max_completion_tokens: 12000,
      response_format: { type: "json_schema", json_schema: { name: "deca_roleplay_score", strict: true, schema: gradingSchema(format.piCount) } },
      messages: [{ role: "developer", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(150_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error("decanet.grading.failed", { status: response.status, code: String(payload?.error?.code ?? "").slice(0, 80) });
    throw new DecanetError(502, "Scoring failed. We'll try again.");
  }
  const content = payload?.choices?.[0]?.message?.content;
  let graded;
  try { graded = JSON.parse(content); } catch { throw new DecanetError(502, "Scoring returned an unreadable result. We'll try again."); }
  console.info("decanet.grading.usage", { model: decanetConfig.graderModel, usage: payload?.usage ?? null });
  return buildResult(roleplay, graded, delivery);
}
