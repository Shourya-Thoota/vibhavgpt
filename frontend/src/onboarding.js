/* ==========================================================================
   Onboarding survey: data model, step config, and prompt mapping.

   The five steps are a config array (ONBOARDING_STEPS) so copy and questions
   can change without touching layout: the view renders a step by its `kind`,
   never by its index.

   Nothing here touches the DOM or React, so the prompt mapping below can be
   reasoned about on its own and reused by Settings as well as by the flow.
   ========================================================================== */

// Stored per user: a shared browser must not leak one account's answers into
// the next person's first message.
const STORAGE_PREFIX = "vibhavgpt-onboarding";
const storageKey = (userId) => (userId ? `${STORAGE_PREFIX}:${userId}` : STORAGE_PREFIX);

/* --- Answer options ------------------------------------------------------ */

// `mode` seeds which workspace gets surfaced first for a role answer. Icons
// are lucide names resolved by the view, so this module stays render-free.
// "code" was offered here before; normalizeOnboarding drops it (and any other
// value not listed) from answers saved by an older build.
export const ROLE_OPTIONS = [
  { value: "study", label: "Study", icon: "GraduationCap", mode: "study" },
  { value: "write", label: "Write", icon: "PenLine", mode: "chat" },
  { value: "research", label: "Research", icon: "Globe", mode: "chat" },
  { value: "images", label: "Create images", icon: "Image", mode: "image" },
  { value: "explore", label: "Explore ideas", icon: "Sparkles", mode: "chat" },
];

// `mode` is the workspace this capability lands in.
export const CAPABILITY_OPTIONS = [
  { value: "chat", label: "Chat", detail: "Ask, write, plan and think out loud.", icon: "MessageSquare", mode: "chat" },
  { value: "images", label: "Images", detail: "Describe a picture and refine it.", icon: "Image", mode: "image" },
  { value: "study", label: "Study", detail: "Learn with explanations, quizzes and flashcards.", icon: "GraduationCap", mode: "study" },
];

// Honest about cost before the choice rather than after it: a Free account
// picking Images is told what it actually costs on this plan.
export const CAPABILITY_FREE_NOTES = {
  images: "Image creation needs Plus or Pro. Flex Credits don't unlock it on Free.",
};

// How much background to assume. "some" is the neutral default and adds no
// instruction; the other two each add one line to the managed block.
export const EXPERTISE_OPTIONS = [
  { value: "new", label: "New to most of it", detail: "Define terms and skip nothing.", icon: "Sprout" },
  { value: "some", label: "Some background", detail: "Explain what isn't obvious.", icon: "Compass" },
  { value: "expert", label: "I know my field", detail: "Skip the basics and go deep.", icon: "Telescope" },
];

// Which measurement system answers should use. "auto" adds no instruction.
export const UNIT_OPTIONS = [
  { value: "auto", label: "Whatever fits", detail: "Follow the question and where you are.", icon: "Globe" },
  { value: "metric", label: "Metric", detail: "Kilometres, kilograms, Celsius.", icon: "Ruler" },
  { value: "imperial", label: "Imperial", detail: "Miles, pounds, Fahrenheit.", icon: "Ruler" },
];

// The sky: Deep Space is the default; Daybreak is a deliberate choice.
export const SKY_OPTIONS = [
  { value: "dark", label: "Deep Space", detail: "Navy night, light ink." },
  { value: "light", label: "Daybreak", detail: "Cool paper, dark ink." },
];

export const PREFERRED_NAME_MAX = 40;

// Each universe is an accent family the app already ships (see ACCENTS in
// App.jsx), so picking one is a token swap, not a new palette. All five
// Settings offers, with the same names. The first three values predate the
// other two and stay as they were, so saved answers keep their accent.
export const THEME_OPTIONS = [
  { value: "deep-space", label: "Orbit cyan", accentId: "cerulean" },
  { value: "nebula", label: "Nebula violet", accentId: "nebula" },
  { value: "pine", label: "Pine", accentId: "pine" },
  { value: "ember", label: "Mars copper", accentId: "ember" },
  { value: "amber", label: "Amber", accentId: "amber" },
];

/* --- Personality axes ---------------------------------------------------- */

// One axis per slider. `low`/`high` are the system-prompt modifiers applied
// outside the neutral band; `reads` are the live readout bands shown while
// dragging. `summary` is the shorthand used in the finish toast.
export const NEUTRAL_LOW = 40;
export const NEUTRAL_HIGH = 60;

export const PERSONALITY_AXES = [
  {
    id: "concise_detailed",
    question: "Length",
    poles: ["Concise", "Detailed"],
    reads: ["Keeps answers short", "Balanced length", "Goes into detail"],
    summary: ["stays brief", "leans detailed"],
    low: "Keep answers brief: give the shortest complete answer and skip preamble.",
    high: "Give thorough answers with the context, examples, and steps that help.",
  },
  {
    id: "casual_formal",
    question: "Tone",
    poles: ["Casual", "Formal"],
    reads: ["Talks casually", "Neutral tone", "Keeps it formal"],
    summary: ["keeps it casual", "keeps it formal"],
    low: "Use a casual, conversational tone and plain words.",
    high: "Use a formal, professional register and precise wording.",
  },
  {
    id: "guide_doer",
    question: "Approach",
    poles: ["Guide me", "Just do it"],
    reads: ["Walks you through it", "Explains as needed", "Just delivers the result"],
    summary: ["walks you through it", "just delivers"],
    low: "Walk the user through the reasoning and teach as you go rather than only handing over a result.",
    high: "Lead with the finished result and keep explanation to what is needed to use it.",
  },
  {
    id: "careful_bold",
    question: "Stance",
    poles: ["Careful", "Bold"],
    reads: ["Hedges carefully", "Measured", "Commits to a call"],
    summary: ["stays careful", "commits to a call"],
    low: "Be careful: flag uncertainty, state assumptions, and name caveats that matter.",
    high: "Commit to a clear recommendation instead of surveying every option, while staying accurate.",
  },
  {
    id: "structured_freeform",
    question: "Shape",
    poles: ["Structured", "Freeform"],
    reads: ["Uses headings and lists", "Structure where it helps", "Writes in prose"],
    summary: ["uses structure", "writes in prose"],
    low: "Structure answers with short headings, lists, or numbered steps.",
    high: "Write in flowing prose and use lists only when a list is genuinely the clearest form.",
  },
];

/* --- The flow ------------------------------------------------------------ */

// Step 1 is the welcome hero; "Step N of M" counts every screen. Every
// question can be left at its default, so Continue always works.
export const ONBOARDING_STEPS = [
  {
    id: "welcome",
    kind: "welcome",
    headline: "Meet VibhavGPT.",
    subline: "A few quick questions and it will feel like yours.",
    cta: "Set up in a minute",
  },
  {
    id: "name",
    kind: "name",
    field: "preferred_name",
    headline: "What should VibhavGPT call you?",
    subline: "Used in greetings and when a reply speaks to you directly. Leave it blank to skip.",
  },
  {
    id: "role",
    kind: "pills",
    field: "role",
    multi: true,
    headline: "What will you use VibhavGPT for?",
    subline: "Pick as many as fit. This decides what gets surfaced first.",
    options: ROLE_OPTIONS,
  },
  {
    id: "expertise",
    kind: "pills",
    field: "expertise",
    multi: false,
    headline: "How much should replies assume you know?",
    subline: "You can always ask for more or less detail in a chat.",
    options: EXPERTISE_OPTIONS,
  },
  {
    id: "personality",
    kind: "sliders",
    field: "personality",
    headline: "Shape how VibhavGPT talks to you.",
    subline: "Drag to taste. You can change any of this later in Settings.",
    axes: PERSONALITY_AXES,
  },
  {
    id: "units",
    kind: "pills",
    field: "units",
    multi: false,
    headline: "Which units do you think in?",
    subline: "For distances, weights, temperatures and recipes.",
    options: UNIT_OPTIONS,
  },
  {
    id: "capability",
    kind: "pills",
    field: "primary_capability",
    multi: false,
    headline: "What matters most?",
    subline: "This becomes the tab VibhavGPT opens on.",
    options: CAPABILITY_OPTIONS,
  },
  {
    id: "theme",
    kind: "themes",
    field: "theme",
    headline: "Pick your sky and universe.",
    subline: "Night or day, and the light running through it. Change either any time in Settings.",
    options: THEME_OPTIONS,
    cta: "Enter VibhavGPT",
  },
];

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

/* --- Record -------------------------------------------------------------- */

export function defaultPersonality() {
  return Object.fromEntries(PERSONALITY_AXES.map((axis) => [axis.id, 50]));
}

export function defaultOnboarding() {
  return {
    onboarding_completed: false,
    preferred_name: "",
    role: [],
    expertise: "some",
    personality: defaultPersonality(),
    units: "auto",
    primary_capability: "chat",
    sky: "dark",
    theme: "deep-space",
  };
}

// A name is one short line of plain text: no markup, no line breaks, and
// nothing that could read as an instruction once it sits in the prompt.
export function cleanPreferredName(value) {
  return String(value ?? "").replace(/[<>{}[\]\\`"]/g, "").replace(/\s+/g, " ").trim().slice(0, PREFERRED_NAME_MAX);
}

const clamp = (value) => Math.min(100, Math.max(0, Math.round(Number(value))));
const oneOf = (options, value, fallback) => (options.some((option) => option.value === value) ? value : fallback);

// Every field is re-validated on read: the record lives in localStorage, where
// a stale shape from an older build or a hand-edited value is always possible.
export function normalizeOnboarding(raw) {
  const base = defaultOnboarding();
  if (!raw || typeof raw !== "object") return base;
  const personality = { ...base.personality };
  for (const axis of PERSONALITY_AXES) {
    const value = raw.personality?.[axis.id];
    if (Number.isFinite(Number(value))) personality[axis.id] = clamp(value);
  }
  return {
    onboarding_completed: raw.onboarding_completed === true,
    preferred_name: cleanPreferredName(raw.preferred_name),
    role: Array.isArray(raw.role)
      ? ROLE_OPTIONS.filter((option) => raw.role.includes(option.value)).map((option) => option.value)
      : [],
    expertise: oneOf(EXPERTISE_OPTIONS, raw.expertise, base.expertise),
    personality,
    units: oneOf(UNIT_OPTIONS, raw.units, base.units),
    primary_capability: oneOf(CAPABILITY_OPTIONS, raw.primary_capability, base.primary_capability),
    sky: oneOf(SKY_OPTIONS, raw.sky, base.sky),
    theme: oneOf(THEME_OPTIONS, raw.theme, base.theme),
  };
}

export function readOnboarding(userId) {
  try {
    return normalizeOnboarding(JSON.parse(localStorage.getItem(storageKey(userId)) ?? "null"));
  } catch {
    // Private mode, blocked site data, or corrupt JSON: a fresh survey is the
    // right answer, not a crash on the first render after sign-in.
    return defaultOnboarding();
  }
}

export function writeOnboarding(userId, record) {
  const normalized = normalizeOnboarding(record);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(normalized));
  } catch {
    // Storage unavailable: the answers still apply to this session.
  }
  return normalized;
}

/* --- Readouts ------------------------------------------------------------ */

const band = (value) => (value < NEUTRAL_LOW ? 0 : value > NEUTRAL_HIGH ? 2 : 1);

export function axisReadout(axis, value) {
  return axis.reads[band(value)];
}

// The finish toast and the Settings summary both want one sentence, so it is
// built from the two answers furthest from neutral, the ones the user
// actually moved, rather than from all five.
export function personalityHeadline(personality) {
  const moved = PERSONALITY_AXES
    .map((axis) => ({ axis, value: personality?.[axis.id] ?? 50 }))
    .filter(({ value }) => band(value) !== 1)
    .sort((a, b) => Math.abs(b.value - 50) - Math.abs(a.value - 50))
    .slice(0, 2)
    .map(({ axis, value }) => axis.summary[value < NEUTRAL_LOW ? 0 : 1]);
  if (!moved.length) return "VibhavGPT will keep its balanced default tone.";
  return `VibhavGPT ${moved.join(" and ")}.`;
}

/* --- System-prompt mapping ----------------------------------------------- */

export function personalityModifiers(personality) {
  return PERSONALITY_AXES
    .map((axis) => {
      const value = personality?.[axis.id] ?? 50;
      return value < NEUTRAL_LOW ? axis.low : value > NEUTRAL_HIGH ? axis.high : null;
    })
    .filter(Boolean);
}

// The length slider also drives the account's existing response style, so a
// chat started before these instructions are read still lands near the right
// verbosity. "friendly" is reserved for Study and is not produced here.
export function responseStyleForPersonality(personality) {
  const value = personality?.concise_detailed ?? 50;
  return value < NEUTRAL_LOW ? "concise" : value > NEUTRAL_HIGH ? "detailed" : "balanced";
}

// Personality is persisted into the account's personal instructions, which
// already reach the system prompt (buildPreferenceSystemPrompt in
// src/chat/prompts.js). The markers keep it a block this flow owns, so
// re-running the survey rewrites its own lines and never eats text the user
// typed in Settings.
export const MANAGED_BLOCK_START = "<!-- vibhavgpt:personality -->";
export const MANAGED_BLOCK_END = "<!-- /vibhavgpt:personality -->";
const MANAGED_BLOCK = new RegExp(`\\n*${MANAGED_BLOCK_START}[\\s\\S]*?${MANAGED_BLOCK_END}`, "g");

export function stripManagedInstructions(instructions = "") {
  return String(instructions).replace(MANAGED_BLOCK, "").trim();
}

const EXPERTISE_LINES = {
  new: "Assume little background: define terms the first time they appear and do not skip steps.",
  expert: "Assume expert background in the user's own field: skip introductory explanations and use precise terminology.",
};
const UNIT_LINES = {
  metric: "Use metric units (kilometres, kilograms, Celsius) unless the user asks otherwise.",
  imperial: "Use imperial units (miles, pounds, Fahrenheit) unless the user asks otherwise.",
};

// Everything the survey says about the person, beyond the personality axes.
export function profileModifiers(record) {
  const name = cleanPreferredName(record?.preferred_name);
  return [
    name ? `Call the user ${name} when addressing them by name is natural.` : null,
    EXPERTISE_LINES[record?.expertise] ?? null,
    UNIT_LINES[record?.units] ?? null,
  ].filter(Boolean);
}

// Accepts the whole survey record, or (as older callers pass) just the
// personality axes.
export function personalityInstructions(recordOrPersonality) {
  const record = recordOrPersonality && "personality" in recordOrPersonality ? recordOrPersonality : { personality: recordOrPersonality };
  const modifiers = [...personalityModifiers(record.personality), ...profileModifiers(record)];
  if (!modifiers.length) return "";
  return [MANAGED_BLOCK_START, "How I like answers written:", ...modifiers.map((line) => `- ${line}`), MANAGED_BLOCK_END].join("\n");
}

// The preferences route caps personal instructions at 4000 characters. When
// the user's own text plus this block would exceed that, the block is dropped
// rather than truncated into half a sentence.
export const MAX_INSTRUCTIONS = 4000;

export function mergeInstructions(existing, recordOrPersonality) {
  const own = stripManagedInstructions(existing);
  const block = personalityInstructions(recordOrPersonality);
  if (!block) return own;
  const merged = own ? `${own}\n\n${block}` : block;
  return merged.length > MAX_INSTRUCTIONS ? own : merged;
}

export function landingModeFor(record) {
  const capability = CAPABILITY_OPTIONS.find((option) => option.value === record?.primary_capability);
  if (capability) return capability.mode;
  // No capability answer (the step was skipped): the first role answer that
  // names a workspace is the next best signal.
  const role = ROLE_OPTIONS.find((option) => record?.role?.includes(option.value) && option.mode !== "chat");
  return role?.mode ?? "chat";
}

export function accentForTheme(theme) {
  return (THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0]).accentId;
}
