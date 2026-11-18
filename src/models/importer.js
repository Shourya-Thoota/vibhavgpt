import {
  createModelEndpoint,
  createModelFamily,
  createModelVersion,
  createPricingSnapshot,
  getModelFamilyBySlug,
  getModelVersion,
  LIFECYCLE_STATES,
  PLAN_ELIGIBILITY,
} from "./registry.js";
import { calculateConsumptionScore } from "./consumption.js";

export const ALLOWLISTED_CATALOG_HOSTS = Object.freeze(new Set([
  "openrouter.ai",
  "api.openai.com",
]));

export const MAX_CATALOG_RESPONSE_BYTES = 1024 * 1024; // 1MB size limit

export class CatalogImportSecurityError extends Error {
  constructor(message, code = "catalog_import_security_error") {
    super(message);
    this.name = "CatalogImportSecurityError";
    this.code = code;
  }
}

/**
 * Validates that an import URL uses HTTPS and points to an approved official host.
 * Also checks that no credentials or basic auth are embedded.
 */
export function validateCatalogUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CatalogImportSecurityError("Invalid catalog URL format", "invalid_url");
  }

  if (parsed.protocol !== "https:") {
    throw new CatalogImportSecurityError("Catalog import requires HTTPS protocol", "insecure_protocol");
  }

  if (parsed.username || parsed.password) {
    throw new CatalogImportSecurityError("Credentials must never be embedded in catalog URL", "credentials_in_url");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWLISTED_CATALOG_HOSTS.has(hostname)) {
    throw new CatalogImportSecurityError(
      `Catalog host '${hostname}' is not in the allowlisted official hosts`,
      "unauthorized_catalog_host",
    );
  }

  return parsed;
}

/**
 * Parses and validates raw OpenRouter or OpenAI catalog JSON objects.
 */
export function normalizeCatalogItem(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) {
    return null;
  }

  const id = String(raw.id).trim();
  const name = String(raw.name || id).trim();
  const [providerNamespace, ...modelParts] = id.includes("/") ? id.split("/") : ["generic", id];
  const modelName = modelParts.join("/");

  // Rates in raw OpenRouter format are USD per token ($1 = 1) or USD per 1M.
  // Standardize to integer micro-dollars per 1M tokens.
  let inputPriceMicrosPerM = null;
  let outputPriceMicrosPerM = null;
  let cachedReadPriceMicrosPerM = null;

  if (raw.pricing && typeof raw.pricing === "object") {
    // OpenRouter pricing is typically USD per 1 token (e.g. 0.0000015 = $1.50 / 1M)
    const rawPrompt = Number(raw.pricing.prompt);
    const rawCompletion = Number(raw.pricing.completion);
    const rawCache = raw.pricing.cached ? Number(raw.pricing.cached) : null;

    if (Number.isFinite(rawPrompt)) {
      if (rawPrompt < 0) throw new CatalogImportSecurityError("Negative prompt price rejected", "invalid_price");
      // OpenRouter quotes USD per token. Multiply by 10^12 to get micro-dollars per 1M tokens:
      // (USD/token) * (10^6 tokens/1M) * (10^6 micro-dollars/USD) = rawPrompt * 10^12
      inputPriceMicrosPerM = Math.round(rawPrompt * 1_000_000_000_000);
    }
    if (Number.isFinite(rawCompletion)) {
      if (rawCompletion < 0) throw new CatalogImportSecurityError("Negative completion price rejected", "invalid_price");
      outputPriceMicrosPerM = Math.round(rawCompletion * 1_000_000_000_000);
    }
    if (Number.isFinite(rawCache)) {
      if (rawCache < 0) throw new CatalogImportSecurityError("Negative cache read price rejected", "invalid_price");
      cachedReadPriceMicrosPerM = Math.round(rawCache * 1_000_000_000_000);
    }
  }

  // Capabilities
  const architecture = raw.architecture || {};
  const modality = architecture.modality || "";
  const supportsVision = modality.includes("image") || Boolean(raw.capabilities?.vision);
  const contextLength = Number.isInteger(raw.context_length) ? raw.context_length : 4096;

  const { calculatedMu, consumptionCategory } = calculateConsumptionScore(
    inputPriceMicrosPerM,
    outputPriceMicrosPerM,
  );

  return {
    familySlug: id.toLowerCase(),
    displayName: name,
    familyGroup: providerNamespace.toLowerCase(),
    versionTag: modelName || id,
    capabilitiesDocumented: {
      vision: supportsVision,
      tools: true,
      streaming: true,
      contextWindowTokens: contextLength,
      architectureModality: modality || "text->text",
    },
    providerName: providerNamespace.toLowerCase(),
    transportType: "router",
    endpointUrl: "https://openrouter.ai/api/v1",
    pricing: {
      inputPriceMicrosPerM,
      outputPriceMicrosPerM,
      cachedReadPriceMicrosPerM,
      calculatedMu,
      consumptionCategory,
      pricingConfidence: inputPriceMicrosPerM !== null ? "provider_reported" : "unknown",
      provenance: "catalog_import:openrouter",
    },
  };
}

/**
 * Imports candidate models from an approved official catalog endpoint.
 * Always defaults to dryRun: true.
 * Candidates are NEVER imported with active or privacy-approved status.
 */
export async function importCatalogFromUrl(
  catalogUrl,
  {
    dryRun = true,
    fetchImpl = fetch,
    timeoutMs = 5000,
    maxBytes = MAX_CATALOG_RESPONSE_BYTES,
    limit = 50,
  } = {},
  executor = null,
) {
  const verifiedUrl = validateCatalogUrl(catalogUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let responseText = "";
  try {
    let res;
    try {
      res = await fetchImpl(verifiedUrl.toString(), {
        signal: controller.signal,
        redirect: "error", // Reject redirects at the HTTP layer
        headers: {
          Accept: "application/json",
          "User-Agent": "VibhavGPT-ModelRegistry-Importer/1.0",
        },
      });
    } catch (err) {
      if (err.name === "AbortError" || controller.signal.aborted) {
        throw new CatalogImportSecurityError("Catalog import operation timed out", "catalog_import_timeout");
      }
      if (err instanceof CatalogImportSecurityError) throw err;
      // Fetch redirect error with redirect: "error"
      if (/redirect/i.test(err.message)) {
        throw new CatalogImportSecurityError("Redirects are prohibited for catalog endpoints", "redirect_prohibited");
      }
      throw err;
    }

    if (controller.signal.aborted) {
      throw new CatalogImportSecurityError("Catalog import operation timed out", "catalog_import_timeout");
    }
    if (!res || typeof res !== "object") {
      throw new CatalogImportSecurityError("No response received from catalog endpoint", "no_response");
    }

    // Validate that final status is not a redirect
    if (res.status >= 300 && res.status < 400) {
      throw new CatalogImportSecurityError("Redirects are prohibited for catalog endpoints", "redirect_prohibited");
    }

    if (!res.ok) {
      throw new CatalogImportSecurityError(
        `Catalog endpoint returned HTTP ${res.status}`,
        "http_error",
      );
    }

    // Validate final destination URL
    if (res.url) {
      let finalParsed;
      try {
        finalParsed = new URL(res.url);
      } catch {
        throw new CatalogImportSecurityError("Invalid final catalog URL", "invalid_url");
      }
      if (finalParsed.protocol !== "https:") {
        throw new CatalogImportSecurityError("Final catalog URL must use HTTPS", "insecure_protocol");
      }
      if (!ALLOWLISTED_CATALOG_HOSTS.has(finalParsed.hostname.toLowerCase())) {
        throw new CatalogImportSecurityError(
          `Final catalog destination host '${finalParsed.hostname}' is not in allowlisted official hosts`,
          "unauthorized_catalog_host",
        );
      }
    }

    const contentLength = Number(res.headers.get("content-length"));
    if (contentLength && contentLength > maxBytes) {
      throw new CatalogImportSecurityError(
        `Catalog response size (${contentLength} bytes) exceeds limit (${maxBytes} bytes)`,
        "response_too_large",
      );
    }

    // Bounded streaming read: read chunks progressively and abort immediately if limit exceeded
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let bytesRead = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunkLen = value?.byteLength ?? value?.length ?? 0;
          bytesRead += chunkLen;
          if (bytesRead > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new CatalogImportSecurityError(
              `Catalog response payload exceeds limit (${maxBytes} bytes)`,
              "response_too_large",
            );
          }
          responseText += decoder.decode(value, { stream: true });
        }
        responseText += decoder.decode();
      } catch (streamErr) {
        if (streamErr.name === "AbortError" || controller.signal.aborted) {
          throw new CatalogImportSecurityError("Catalog import operation timed out", "catalog_import_timeout");
        }
        throw streamErr;
      }
    } else {
      // Fallback for mock environments without streaming body
      const rawText = await res.text();
      if (rawText.length > maxBytes) {
        throw new CatalogImportSecurityError(
          `Catalog response payload exceeds limit (${maxBytes} bytes)`,
          "response_too_large",
        );
      }
      responseText = rawText;
    }
  } finally {
    clearTimeout(timeoutId);
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(responseText);
  } catch {
    throw new CatalogImportSecurityError("Malformed JSON response from catalog", "invalid_json");
  }

  const rawList = Array.isArray(parsedJson.data) ? parsedJson.data : (Array.isArray(parsedJson) ? parsedJson : []);
  const normalizedCandidates = [];

  for (const raw of rawList.slice(0, limit)) {
    const candidate = normalizeCatalogItem(raw);
    if (candidate) {
      normalizedCandidates.push(candidate);
    }
  }

  if (dryRun) {
    return {
      dryRun: true,
      importedCount: 0,
      candidatesFound: normalizedCandidates.length,
      candidates: normalizedCandidates,
    };
  }

  // If dryRun is false, persist candidates into registry
  const db = executor;
  const persistedResults = [];

  for (const item of normalizedCandidates) {
    const family = await createModelFamily({
      slug: item.familySlug,
      displayName: item.displayName,
      familyGroup: item.familyGroup,
    }, db);

    // Candidates are ALWAYS inserted in CANDIDATE lifecycle state
    const version = await createModelVersion({
      familyId: family.id,
      versionTag: item.versionTag,
      capabilitiesDocumented: item.capabilitiesDocumented,
      planEligibility: PLAN_ELIGIBILITY.PAID,
      lifecycleState: LIFECYCLE_STATES.CANDIDATE,
      metadata: { importedFrom: verifiedUrl.hostname, importedAt: new Date().toISOString() },
    }, db);

    const endpoint = await createModelEndpoint({
      versionId: version.id,
      providerName: item.providerName,
      transportType: item.transportType,
      adapterType: "chat_completions",
      endpointUrl: item.endpointUrl,
      capabilitiesVerified: {
        streaming: true,
        vision: item.capabilitiesDocumented.vision,
        tools: true,
      },
      privacyReview: {
        privacyApproved: false, // Imported models are NEVER privacy-approved automatically!
        trainingPolicy: "unknown",
        dataRetentionDays: null,
        zeroDataRetention: false,
        auditRef: null,
        reviewedBy: null,
      },
      endpointState: LIFECYCLE_STATES.CANDIDATE,
    }, db);

    let pricingSnapshot = null;
    if (item.pricing) {
      pricingSnapshot = await createPricingSnapshot({
        endpointId: endpoint.id,
        pricingVersionId: `import_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
        inputPriceMicrosPerM: item.pricing.inputPriceMicrosPerM,
        outputPriceMicrosPerM: item.pricing.outputPriceMicrosPerM,
        cachedReadPriceMicrosPerM: item.pricing.cachedReadPriceMicrosPerM,
        pricingConfidence: item.pricing.pricingConfidence,
        provenance: item.pricing.provenance,
      }, db);
    }

    persistedResults.push({ family, version, endpoint, pricingSnapshot });
  }

  return {
    dryRun: false,
    importedCount: persistedResults.length,
    records: persistedResults,
  };
}
