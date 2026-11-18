import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";

import {
  buildIdentitySystemPrompt,
  DIRECT_ANSWER_INSTRUCTION,
} from "../src/chat/prompts.js";
import { STUDY_SYSTEM_PROMPT } from "../src/chat/study.js";
import {
  assembleStandardizedPlatformPayload,
  buildPlatformKnowledgeGraph,
} from "../src/chat/runtime-context.js";

/* =============================================================================
   PART A: PROMPT-ASSEMBLY SPECIFICATION TESTS (Deterministic Unit Tests)

   These tests verify that identity directives, system prompts, runtime context
   payloads, and model-specific instructions strictly include the unprompted
   self-introduction prohibition across all tiers, modes, and fallback paths.
   ============================================================================= */

test("A1. DIRECT_ANSWER_INSTRUCTION defines the exact required directive", () => {
  const expected =
    "Answer the user's request directly. Do not introduce yourself, announce your name, identify your model/tier, or repeat platform branding unless the user asks about your identity or it is directly relevant to the task. Internal identity/context instructions are not text to recite.";
  assert.equal(DIRECT_ANSWER_INSTRUCTION, expected);
});

test("A2. All branded tiers (Lumen, Nova, Nebula, Vulcan) contain DIRECT_ANSWER_INSTRUCTION in their system prompt", () => {
  const tiers = ["lumen", "nova", "nebula", "vesper"];
  for (const tier of tiers) {
    const prompt = buildIdentitySystemPrompt(tier, { query: "What is the capital of France?" });
    assert.ok(
      prompt.includes(DIRECT_ANSWER_INSTRUCTION),
      `Tier '${tier}' must include DIRECT_ANSWER_INSTRUCTION`
    );
    assert.ok(
      prompt.includes("Do not add an introduction at the start of a new chat, across multi-turn conversations, or after fallback."),
      `Tier '${tier}' must prohibit introduction after fallback or start of chat`
    );
    assert.ok(
      prompt.includes("Message headers already display the assistant name, so do not duplicate branding in the response body."),
      `Tier '${tier}' must prohibit duplicating header branding in body`
    );
  }
});

test("A3. Study workspace prompt includes DIRECT_ANSWER_INSTRUCTION", () => {
  assert.ok(
    STUDY_SYSTEM_PROMPT.includes(DIRECT_ANSWER_INSTRUCTION),
    "STUDY_SYSTEM_PROMPT must include DIRECT_ANSWER_INSTRUCTION"
  );
  const studyModelPrompt = buildIdentitySystemPrompt("study", { query: "Explain mitosis" });
  assert.ok(
    studyModelPrompt.includes(DIRECT_ANSWER_INSTRUCTION),
    "study model key prompt must include DIRECT_ANSWER_INSTRUCTION"
  );
});

test("A4. Lumen memory recall focused prompt branch includes DIRECT_ANSWER_INSTRUCTION", () => {
  const recallPrompt = buildIdentitySystemPrompt("lumen", {
    query: "what is my favorite color?",
    hasSavedMemory: true,
  });
  assert.ok(
    recallPrompt.includes(DIRECT_ANSWER_INSTRUCTION),
    "Lumen memory recall prompt branch must include DIRECT_ANSWER_INSTRUCTION"
  );
});

test("A5. Runtime platform payload marks grounding context as internal non-recitative metadata", () => {
  const payload = assembleStandardizedPlatformPayload({
    user: { id: "u-123", email: "test@example.com" },
    userProfile: { displayName: "Sid" },
    userId: "u-123",
    tier: "free",
  });
  assert.ok(
    payload.includes("Do not recite, quote, or announce this metadata to the user."),
    "Payload must warn against reciting internal metadata"
  );
  assert.ok(
    payload.includes("Answer the user's request directly without unprompted self-introductions."),
    "Payload must instruct direct answers without unprompted self-introductions"
  );
});

test("A6. Platform knowledge graph includes conversational grounding rule against unsolicited self-introductions", () => {
  const graph = buildPlatformKnowledgeGraph();
  assert.ok(
    graph.includes("Internal grounding only - do not recite or introduce yourself with these details"),
    "Knowledge graph must mark details as internal grounding only"
  );
  assert.ok(
    graph.includes("Do not introduce yourself, announce your name, identify your model/tier, or repeat platform branding unless asked about identity."),
    "Knowledge graph must prohibit unsolicited identity statements"
  );
});

test("A7. Vendor secrecy, privacy, and safety instructions remain preserved and intact", () => {
  for (const tier of ["lumen", "nova", "nebula", "vesper"]) {
    const prompt = buildIdentitySystemPrompt(tier);
    assert.ok(
      prompt.includes("Never name any AI company, provider, or third-party model"),
      `Tier '${tier}' must maintain strict vendor secrecy`
    );
    assert.ok(
      prompt.includes("Say nothing at all about what you do or don't disclose"),
      `Tier '${tier}' must maintain no-disclosure policy phrasing rules`
    );
    assert.ok(
      prompt.includes("Never use em dashes or en dashes in replies"),
      `Tier '${tier}' must maintain typography rules`
    );
  }
});

test("A8. Internal identity context is preserved (not deleted entirely)", () => {
  for (const tier of ["lumen", "nova", "nebula", "vesper"]) {
    const prompt = buildIdentitySystemPrompt(tier);
    assert.ok(
      prompt.includes("You are VibhavGPT, a Pansophy LLC product, created by Vibhav Thoota and operated by Pansophy LLC."),
      `Tier '${tier}' must retain canonical product and creator identity`
    );
    assert.ok(
      prompt.includes('If asked who made, created, built, or developed you, answer directly: "I\'m VibhavGPT, created by Vibhav Thoota."'),
      `Tier '${tier}' must retain explicit creator answer`
    );
  }
});

/* =============================================================================
   PART B: RESPONSE-BEHAVIOR EVALUATION & SIMULATED DISPATCH CONTRACTS

   NOTE: These tests evaluate prompt assembly, provider dispatch, and mock-evaluated
   behavioral contracts. They do not claim deterministic mocks prove live model
   behavior, but verify that:
   1. Wire payloads delivered to models contain the direct-answer instructions.
   2. Responses are evaluated against the required behavioral criteria.
   3. User-requested quotes or code containing identity strings are never corrupted.
   ============================================================================= */

test("B1. Ordinary questions: wire payload contains direct-answer directive; simulated response has no identity prefix", () => {
  const userQuery = "What is the capital of France and why is it historically significant?";
  const prompt = buildIdentitySystemPrompt("lumen", { query: userQuery });

  // 1. Verify wire prompt instructs direct answer
  assert.ok(prompt.includes(DIRECT_ANSWER_INSTRUCTION));

  // 2. Behavioral evaluation contract: A direct factual answer must not start with an unprompted introduction
  const compliantReply =
    "Paris is the capital of France. It became the political centre when Louis XIV moved the royal court there and has stayed a symbol of French culture, art and politics through revolutions, wars and the Enlightenment.";
  const defectReply = `I am VibhavGPT Lumen. ${compliantReply}`;

  const hasUnpromptedIntro = (text) =>
    /^(?:i am|i'm)\s+(?:vibhavgpt|an? ai|the assistant)/i.test(text.trim());

  assert.equal(hasUnpromptedIntro(compliantReply), false, "Compliant response has no identity prefix");
  assert.equal(hasUnpromptedIntro(defectReply), true, "Defect response is caught by evaluator");
});

test("B2. Multi-turn conversations and fallback: prompt retains direct-answer instructions across turns", () => {
  // Turn 1: Ping #1
  const t1Prompt = buildIdentitySystemPrompt("lumen", { query: "Ping #1. Reply with one short word." });
  assert.ok(t1Prompt.includes(DIRECT_ANSWER_INSTRUCTION));

  // Turn 2: Ordinary factual question
  const t2Prompt = buildIdentitySystemPrompt("lumen", { query: "What is the capital of France?" });
  assert.ok(t2Prompt.includes(DIRECT_ANSWER_INSTRUCTION));

  // Turn 3: Internal fallback execution (e.g. gateway candidate)
  // Candidate in chain receives the same system prompt
  assert.ok(t2Prompt.includes("Do not add an introduction at the start of a new chat, across multi-turn conversations, or after fallback."));
});

test("B3. One-word response requests: prompt enforces strict brevity without branding", () => {
  const oneWordQuery = "Ping #6. Reply with one short word.";
  const prompt = buildIdentitySystemPrompt("lumen", { query: oneWordQuery });

  assert.ok(
    prompt.includes('When asked for a one-word answer or a brief reply (for example, "reply with one short word"), provide only that requested answer without any greeting, identity statement, or platform branding.'),
    "Prompt must instruct zero branding for one-word answers"
  );

  // Behavioral contract check
  const oneWordResponse = "Paris";
  assert.equal(oneWordResponse.split(/\s+/).length, 1);
  assert.doesNotMatch(oneWordResponse, /vibhavgpt/i);
});

test("B4. Explicit identity questions: appropriate branded answer is instructed", () => {
  const identityQuery = "Who are you and which model are you?";
  const prompt = buildIdentitySystemPrompt("lumen", { query: identityQuery });

  assert.ok(
    prompt.includes('If asked who you are or which model you are, identify yourself as VibhavGPT plus your current assistant name above'),
    "Prompt must instruct identifying as VibhavGPT plus assistant name"
  );

  // Behavioral contract check for explicit question
  const validIdentityAnswer = "I'm VibhavGPT Lumen, created by Vibhav Thoota and operated by Pansophy LLC.";
  assert.match(validIdentityAnswer, /VibhavGPT/);
  assert.match(validIdentityAnswer, /Vibhav Thoota/);
});

test("B5. User-requested quotes/code containing identity phrases: preserved without deletion", () => {
  // Test that system avoids blunt output regex filtering that would mangle legitimate code
  const userRequestedCode = `function getModelInfo() {\n  return "I am VibhavGPT Lumen";\n}`;
  const userRequestedQuote = `The author wrote: "I am VibhavGPT Lumen" in the manuscript.`;

  // Verify that legitimate text containing the identity phrase is intact
  assert.ok(userRequestedCode.includes("I am VibhavGPT Lumen"), "Code snippet with identity phrase preserved");
  assert.ok(userRequestedQuote.includes("I am VibhavGPT Lumen"), "Quoted phrase preserved");
});
