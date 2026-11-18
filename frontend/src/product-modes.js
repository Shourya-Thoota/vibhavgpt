// Build (owner request, 2026-11-14) is the coding workspace: chats with VibhavGPT Tecton, Pro and up.
export const productModeFromPath = (path) => /^\/app\/study\/?$/.test(path) ? "study" : /^\/app\/image\/?$/.test(path) ? "image" : /^\/app\/build\/?$/.test(path) ? "build" : "chat";
export const productPath = (mode, conversationId) => `${mode === "study" ? "/app/study" : mode === "image" ? "/app/image" : mode === "build" ? "/app/build" : "/app/chat"}${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ""}`;
/** The model Build always uses, and the plans that include it. */
export const BUILD_MODEL = "tecton";
export const buildIncluded = (tier) => ["pro", "max", "paid"].includes(String(tier ?? "").toLowerCase());
export const STUDY_ACTIONS = [
  { label: "Explain this", prompt: "Explain the main concept in the selected study material, using a worked example and a short check for understanding." },
  { label: "Make flashcards", prompt: "Make 6 question-and-answer flashcards from the selected study material. Keep one concept per card." },
  { label: "Quiz me", prompt: "Quiz me on the selected study material. Ask one question at a time and wait for my answer before giving feedback." },
  { label: "Create a study plan", prompt: "Create a practical study plan for the selected study material. If my deadline or available study time is missing, ask me first." },
  { label: "Summarize my notes", prompt: "Summarize my selected study notes with key terms, important facts, and any limitations in the source." },
];

export const STUDY_TAGLINES = [
  "What are you studying?",
  "Which topic is next?",
  "What should we study today?",
  "Paste your notes to begin.",
  "What do you want to learn?",
];
export const STUDY_STARTERS = ["Explain a topic", "Flashcards", "Quiz me", "Summary", "Study plan"];
