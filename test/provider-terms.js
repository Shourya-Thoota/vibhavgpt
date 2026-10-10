// The provider and model-family names that must never reach users, from
// PROVIDER_NAME_TERMS (placeholders unless a real list is configured), as
// one case-insensitive pattern for the name-guard assertions.
const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, " ?");
export const providerTerms = (process.env.PROVIDER_NAME_TERMS ?? "").split(",").map((term) => term.trim()).filter(Boolean);
export const providerTermsPattern = new RegExp(`\\b(?:${providerTerms.map(escape).join("|")})\\b`, "i");
