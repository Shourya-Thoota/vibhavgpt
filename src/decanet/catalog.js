import { CENTURY_SKILLS, CLUSTERS, EVENT_FORMATS, EVENTS, SKILL_MAX, findEvent } from "./events.js";
import { ROLEPLAYS } from "./roleplays/index.js";

// Voices are chosen from the judge's name, so a judge always sounds the same
// for everyone and the five judges in an event sound different from each other.
const VOICES = { f: ["coral", "shimmer", "sage", "marin"], m: ["ash", "echo", "verse", "cedar", "ballad"] };

function hashName(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash;
}

export function voiceFor(name, gender) {
  const pool = VOICES[gender] ?? VOICES.f;
  return pool[hashName(name) % pool.length];
}

// The four rating bands of a DECA rubric, scaled to an item's maximum.
export function ratingBands(max) {
  if (max === 14) return [["Little/No Value", 0, 3], ["Below Expectations", 4, 7], ["Meets Expectations", 8, 11], ["Exceeds Expectations", 12, 14]];
  if (max === 10) return [["Little/No Value", 0, 2], ["Below Expectations", 3, 5], ["Meets Expectations", 6, 8], ["Exceeds Expectations", 9, 10]];
  if (max === 6) return [["Little/No Value", 0, 1], ["Below Expectations", 2, 3], ["Meets Expectations", 4, 5], ["Exceeds Expectations", 6, 6]];
  throw new Error(`No rating bands for a ${max}-point item.`);
}

export function ratingFor(score, max) {
  return ratingBands(max).find(([, low, high]) => score >= low && score <= high)?.[0] ?? "Little/No Value";
}

function closingParagraph(roleplay, format) {
  const judge = roleplay.judge.role;
  if (format.team) {
    return `You will present your recommendations to the ${judge} in a meeting to take place in the ${judge}'s office. The ${judge} will begin the meeting by greeting your team and asking to hear your ideas. After you have presented your recommendations and have answered the ${judge}'s questions, the ${judge} will conclude the meeting by thanking your team for its work.`;
  }
  return `You will present your ideas to the ${judge} in a role-play to take place in the ${judge}'s office. The ${judge} will begin the role-play by greeting you and asking to hear your ideas. After you have presented your ideas and have answered the ${judge}'s questions, the ${judge} will conclude the role-play by thanking you for your work.`;
}

function participantInstructions(format) {
  const prep = format.prepSeconds / 60, talk = format.roleplaySeconds / 60;
  if (format.team) {
    return [
      "The event will be presented to your team through your reading of the case study, including the 21st Century Skills and Performance Indicators.",
      `You will have up to ${prep} minutes to review this information and prepare your presentation. You may make notes to use during your presentation.`,
      `You will have up to ${talk} minutes to present to the judge: about ${talk - 5} minutes to present your recommendations, and the remaining time to answer the judge's questions. In DECANet you speak for the whole team.`,
      "You will be evaluated on how well you demonstrate the 21st Century Skills and meet the performance indicators of this event.",
      "When the presentation begins, the case study is put away. Only your notes stay with you.",
    ];
  }
  return [
    "The event will be presented to you through your reading of these instructions, including the 21st Century Skills and Performance Indicators.",
    `You will have up to ${prep} minutes to review this information and prepare your presentation. You may make notes to use during your presentation.`,
    `You will have up to ${talk} minutes to make your presentation to the judge, including time for the judge's questions.`,
    "You will be evaluated on how well you demonstrate the 21st Century Skills and meet the performance indicators of this event.",
    "When the role-play begins, these instructions are put away. Only your notes stay with you.",
  ];
}

function build(event, entry, index) {
  const format = EVENT_FORMATS[event.format];
  const number = index + 1;
  const judge = { name: entry.judge[0], gender: entry.judge[1], role: entry.judge[2] };
  return {
    id: `${event.code}-${number}`,
    eventCode: event.code,
    number,
    instructionalArea: entry.ia,
    title: entry.title,
    company: entry.company,
    participantRole: entry.role,
    judge: { ...judge, voice: voiceFor(judge.name, judge.gender) },
    performanceIndicators: entry.pis,
    situation: entry.situation.trim().split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim()),
    characterization: entry.character.replace(/\s+/g, " ").trim(),
    questions: entry.questions,
    format: event.format,
  };
}

export const CATALOG = new Map();
for (const event of EVENTS) {
  const entries = ROLEPLAYS[event.code];
  if (!entries) continue;
  entries.forEach((entry, index) => {
    const roleplay = build(event, entry, index);
    CATALOG.set(roleplay.id, roleplay);
  });
}

export function findRoleplay(id) {
  return CATALOG.get(String(id ?? "")) ?? null;
}

export function roleplaysForEvent(code) {
  const event = findEvent(code);
  if (!event) return [];
  return [...CATALOG.values()].filter((roleplay) => roleplay.eventCode === event.code);
}

// What anyone can see before spending a credit: the number, the
// instructional area and the title. No situation, indicators or judge.
export function roleplaySummary(roleplay) {
  return { id: roleplay.id, number: roleplay.number, instructionalArea: roleplay.instructionalArea, title: roleplay.title };
}

export function eventSummary(event) {
  const format = EVENT_FORMATS[event.format];
  return {
    code: event.code, name: event.name, cluster: CLUSTERS[event.cluster], format: event.format, formatLabel: format.label,
    prepMinutes: format.prepSeconds / 60, roleplayMinutes: format.roleplaySeconds / 60, team: format.team,
    instructionalAreas: roleplaysForEvent(event.code).map((roleplay) => roleplay.instructionalArea),
  };
}

// The participant's packet: everything needed to prepare, nothing from the
// judge's side (no name, characterization, questions or rubric).
export function participantDocument(roleplay) {
  const event = findEvent(roleplay.eventCode);
  const format = EVENT_FORMATS[event.format];
  return {
    id: roleplay.id,
    eventCode: event.code,
    eventName: event.name,
    cluster: `${CLUSTERS[event.cluster]} Cluster`,
    kind: format.team ? "Case Study" : "Role-Play",
    number: roleplay.number,
    instructionalArea: roleplay.instructionalArea,
    title: roleplay.title,
    participantRole: roleplay.participantRole,
    company: roleplay.company,
    judgeRole: roleplay.judge.role,
    instructions: participantInstructions(format),
    centurySkills: CENTURY_SKILLS.map(({ label, detail }) => ({ label, detail })),
    performanceIndicators: roleplay.performanceIndicators,
    situation: [...roleplay.situation, closingParagraph(roleplay, format)],
    prepSeconds: format.prepSeconds,
    roleplaySeconds: format.roleplaySeconds,
  };
}

export function rubricFor(roleplay) {
  const format = EVENT_FORMATS[roleplay.format];
  return {
    performanceIndicators: roleplay.performanceIndicators.map((text, index) => ({ index, text, max: format.piMax, bands: ratingBands(format.piMax) })),
    skills: CENTURY_SKILLS.map((skill) => ({ ...skill, max: SKILL_MAX, bands: ratingBands(SKILL_MAX) })),
    total: format.piCount * format.piMax + CENTURY_SKILLS.length * SKILL_MAX,
  };
}
