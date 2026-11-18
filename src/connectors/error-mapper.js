// Maps user-facing connector errors to clean, branded wording and logs the
// original server-side only. Vendor names (e.g. Composio) and internal credentials
// must never reach the client in HTTP response bodies, error codes, notices,
// or stored action records.

import { TOOLKIT_METADATA } from "./composio-adapter.js";
import { TOOL_TO_CONNECTOR_MAP } from "./service.js";

const VENDOR_LEAKS = /\bcomposio(?:\.dev)?\b|openrouter|openai|anthropic|gemini|groq|deepseek|qwen|moonshot|kimi/gi;
const SECRET_LEAKS = /(?:ck_|sk_|ya29\.|Bearer\s+)[A-Za-z0-9._-]{8,}/gi;
const ENV_LEAKS = /\bCOMPOSIO_[A-Z_]+\b/g;

export function serviceNameForSlug(slug) {
  const prefix = String(slug || "").split("_")[0].toLowerCase();
  return Object.prototype.hasOwnProperty.call(TOOLKIT_METADATA || {}, prefix) ? TOOLKIT_METADATA[prefix].name : null;
}

export function serviceNameForTool(toolName) {
  if (!toolName) return null;
  const connectorId = TOOL_TO_CONNECTOR_MAP?.[toolName];
  if (connectorId && TOOLKIT_METADATA?.[connectorId]?.name) {
    return TOOLKIT_METADATA[connectorId].name;
  }
  return serviceNameForSlug(toolName) || null;
}

/**
 * Strips vendor names and credential strings from any user-facing text.
 */
export function scrubVendorNames(text, fallbackServiceName = null) {
  if (typeof text !== "string") return "";
  return text
    .replace(SECRET_LEAKS, "[redacted]")
    .replace(ENV_LEAKS, "deployment settings")
    .replace(VENDOR_LEAKS, fallbackServiceName || "connector service")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sanitizes connector metadata before returning it in user-facing summaries.
 * Removes internal vendor fields, synced flags, and provider redirect URLs.
 */
export function sanitizeConnectorMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const cleaned = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/composio/i.test(key)) continue;
    if (typeof value === "string" && /composio\.dev/i.test(value)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Central mapper for all user-facing connector errors.
 * Logs the original error server-side and returns safe, branded wording.
 */
export function mapConnectorError(error, { service = null, toolName = null, code = null } = {}) {
  const rawMessage = typeof error === "string" ? error : (error?.message || "Connector error occurred.");
  const originalCode = error?.code || code || null;
  const serviceName = service || serviceNameForTool(toolName) || "Connector";

  // Server-side logging: keep full diagnostics for operators without leaking to client
  console.warn(JSON.stringify({
    event: "connector_error",
    service: serviceName,
    tool: toolName || null,
    code: originalCode,
    originalMessage: rawMessage,
    errorType: error?.name || "Error",
  }));

  // 1. Configuration errors
  if (/composio.*not configured|missing COMPOSIO_API_KEY|configuration_required|connector service is not configured/i.test(rawMessage)) {
    return {
      message: "Connector service is not configured.",
      code: "configuration_required",
      status: 503,
    };
  }

  // 1b. The provider does not offer the tool that was asked for. Nothing ran. The raw tool name stays in the diagnostics logged above.
  if (/\btool\b[^\n]{0,80}\bnot\s+found\b|\bno\s+such\s+tool\b|\btool_not_found\b/i.test(rawMessage)) {
    return {
      message: `${serviceName} doesn't offer this action right now.`,
      code: "tool_unavailable",
      status: 404,
    };
  }

  // 2. Permission / insufficient scope errors
  if (/insufficient\s+(?:permission|scope)|missing\s+scope|forbidden|\b403\b|access\s+not\s+configured/i.test(rawMessage)) {
    return {
      message: `${serviceName} did not allow this action with the current permissions. Reconnect ${serviceName} in Extensions > Connectors and grant the missing access.`,
      code: "insufficient_scope",
      status: 403,
    };
  }

  // 3. Authorization expired or revoked
  if (/unauthori[sz]ed|\b401\b|expired|invalid[_\s]grant|invalid[_\s]credentials?|revoked|re-?auth/i.test(rawMessage)) {
    return {
      message: `${serviceName} sign-in has expired or was revoked. Reconnect ${serviceName} in Extensions > Connectors.`,
      code: "authorization_expired",
      status: 401,
    };
  }

  // 4. Timeout errors
  if (/time(?:d)?[\s-]?out|etimedout|econnaborted|deadline/i.test(rawMessage)) {
    return {
      message: `${serviceName} did not respond in time. Please try again.`,
      code: "timeout",
      status: 504,
    };
  }

  // 5. Rate limit or quota errors
  if (/quota|rate\s*limit/i.test(rawMessage)) {
    return {
      message: `${serviceName} rate limit or quota exceeded. Please try again later.`,
      code: "rate_limit_exceeded",
      status: 429,
    };
  }

  // 6. Multi-execute batch failures
  if (/^\d+ out of \d+ tools failed$/i.test(rawMessage.trim())) {
    if (serviceName === "Google Drive") {
      return {
        message: "Google Drive rejected the upload before it confirmed a file.",
        code: "provider_rejected",
        status: 400,
      };
    }
    return {
      message: `${serviceName} rejected the request before it confirmed a result.`,
      code: "provider_rejected",
      status: 400,
    };
  }

  // 7. Action integrity / state transitions
  if (/mismatch|tampered/i.test(rawMessage)) {
    return {
      message: "Action payload mismatch or approval has been tampered with.",
      code: "payload_mismatch",
      status: 400,
    };
  }

  if (/expired before it was executed/i.test(rawMessage)) {
    return {
      message: "This approval expired before it was executed.",
      code: "expired",
      status: 409,
    };
  }

  if (/disabled by user/i.test(rawMessage)) {
    return {
      message: `Execution blocked: ${serviceName} is disabled by user.`,
      code: "service_disabled",
      status: 403,
    };
  }

  // 8. General errors: scrub any vendor references
  const scrubbed = scrubVendorNames(rawMessage, serviceName);
  return {
    message: scrubbed || `${serviceName} action could not be completed.`,
    code: originalCode || "connector_error",
    status: 400,
  };
}
