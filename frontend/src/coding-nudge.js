import { canonicalModelKey } from "./token-quotas.js";

export const CODING_NUDGE_COPY = "Nebula writes better code.";

// Deliberately conservative: explicit code requests only, with no project work
// or attached files whose scope cannot be inferred from a short message.
export function shouldSuggestNebula(prompt, model, attachmentCount = 0) {
  if (canonicalModelKey(model) === "nebula" || attachmentCount > 0 || typeof prompt !== "string") return false;
  const text = prompt.trim();
  if (!text || text.length > 350 || text.split(/\s+/).length > 60) return false;
  if (/\b(?:large|complex|comprehensive|entire|full[ -]?stack|production[ -]?ready|multi[ -]?(?:file|service)|architecture|codebase|repository|microservices|project|application|website|app|platform|authentication|database|deployment|distributed|scalable)\b/i.test(text)) return false;
  if (/\b(?:poem|essay|story|article)\b|\b(?:explain|describe)\s+(?:what|why|how)\b/i.test(text)) return false;
  if (!/\b(?:write|create|make|build|generate|give|show|implement|fix|debug|code)\b/i.test(text)) return false;
  if (!/\b(?:code|snippet|script|function|regex|sql|python|javascript|typescript|html|css|bash|shell|java|c\+\+|rust|golang)\b/i.test(text)) return false;
  return /\b(?:small|short|tiny|simple|basic|snippet|one[ -]?liner)\b/i.test(text) || text.length <= 180;
}
