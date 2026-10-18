import { config } from "../config.js";

// Names of the AI companies and models behind VibhavGPT. They must never
// reach the user (scrubbed from live thinking) or be stored or sent as
// account facts (memory). PROVIDER_NAME_TERMS lists them by hand; the names
// of the models and providers actually configured are added here too, so a
// model change cannot leave its own name unprotected (moonshotai/kimi-k2.6
// adds moonshotai, moonshot, kimi, kimi-k2.6 and "kimi k2.6").

// Never treated as a provider name: our own names and words too common to
// scrub (a model id's tier words, and placeholder hosts).
const BRAND = /vibhav|pansophy|\b(?:lumen|nova|nebula|vesper|study|comet)\b/i;
const GENERIC = new Set([
  "free", "flash", "lite", "pro", "mini", "max", "auto", "chat", "instruct", "latest", "preview", "turbo", "large", "small", "base",
  "model", "models", "router", "api", "www", "app", "default", "fixture", "example", "test", "local", "localhost", "invalid",
  "primary", "gateway", "secondary", "reserve", "direct", "paid", "moderation", "memory", "search", "image", "images", "voice",
  "realtime", "transcribe", "transcription", "speech", "audio", "vision", "text", "online", "beta", "stable", "new",
]);

const valid = (term) => term.length >= 4 && /^[a-z][a-z0-9.\- ]*$/.test(term) && !GENERIC.has(term) && !BRAND.test(term);

function modelTerms(id) {
  const terms = [];
  const value = String(id ?? "").trim().toLowerCase().replace(/:.*$/, "");
  if (!value) return terms;
  const [org, name] = value.includes("/") ? value.split("/", 2) : [null, value];
  if (org) {
    terms.push(org, org.replace(/-/g, ""));
    // "moonshotai" is also written "Moonshot"; a short stem ("open" from
    // "openai") is an everyday word and is left alone.
    const stem = org.replace(/-/g, "").replace(/ai$/, "");
    if (stem !== org.replace(/-/g, "") && stem.length >= 6) terms.push(stem);
  }
  const family = name.match(/^[a-z]+/)?.[0];
  if (family) terms.push(family);
  // The model's own name with its version ("kimi-k2.6"), written either way.
  if (/\d/.test(name) && name.length >= 5) terms.push(name, name.replace(/-/g, " "));
  return terms;
}

function hostTerms(url) {
  try {
    const labels = new URL(url).hostname.toLowerCase().split(".");
    return labels.length >= 2 ? [labels[labels.length - 2]] : [];
  } catch {
    return [];
  }
}

export function derivedProviderNameTerms(source = config) {
  const models = [
    ...Object.values(source.chatModels ?? {}),
    source.searchIntentModel, source.memoryExtractionModel, source.moderationModel, source.imageGenerationModel,
    source.voice?.realtimeModel, source.voice?.transcriptionModel,
  ];
  const hosts = [...Object.values(source.providerBaseUrls ?? {}), source.moderationApiUrl];
  return [...new Set([...models.flatMap(modelTerms), ...hosts.flatMap(hostTerms)].map((term) => term.trim()).filter(valid))];
}

// PROVIDER_NAME_TERMS plus the configured models' and providers' names.
export function providerNameTerms(source = config) {
  const listed = (source.providerNameTerms ?? []).map((term) => String(term).trim().toLowerCase()).filter(Boolean);
  return [...new Set([...listed, ...derivedProviderNameTerms(source)])];
}
