// Tells apart why a connector read failed, so the model is given a true reason
// and not one catch-all sentence. The model is told what happened and what it
// must not claim; it is never given the provider's raw text.
//
//   permission            the account is connected but lacks the access this needs
//   authorization_expired the sign-in expired, was revoked, or the provider no longer has the connection; reconnecting fixes it
//   quota                 the service's own usage limit was reached; nothing is wrong with the account and reconnecting does not help
//   bad_arguments         the request was rejected as malformed (our side, not the user's)
//   timeout               the provider did not answer in time
//   provider_failure      the provider failed, or the cause is not identifiable
//
// "Unsupported capability" is decided before a call (no tool exists or it is
// unmapped) and never reaches this classifier.
//
// The order matters and is the contract: a reason the provider gave (a known token or an HTTP status) is trusted before words in a message.

const QUOTA_REASON = /^(?:quotaExceeded|rateLimitExceeded|dailyLimitExceeded|userRateLimitExceeded|limitExceeded)$/;
const PERMISSION_REASON = /^(?:insufficientPermissions|forbidden|accessNotConfigured|youtubeSignupRequired)$/;
const AUTH_REASON = /^(?:authError|invalidCredentials|keyInvalid)$/;
const BAD_REQUEST_REASON = /^(?:required|invalidParameter|badRequest)$/;

const PERMISSION = /insufficient\s+(?:permission|scope|authentication\s+scope)|missing\s+scope|scope|permission|forbidden|\b403\b|access\s+not\s+configured/i;
const QUOTA = /quota|rate\s*limit|too\s+many\s+requests/i;
// A transport-level rejection of the platform's own key, not the user's sign-in: reconnecting cannot fix it.
const PLATFORM_KEY = /^Composio (?:MCP error|tool execution failed) \((?:401|403)\)/i;
const EXPIRED = /unauthori[sz]ed|\b401\b|expired|invalid[_\s]grant|invalid[_\s]credentials?|revoked|re-?auth|token\s+(?:is\s+)?(?:invalid|no longer)/i;
// The provider has no live connection for this user and service: the sign-in is gone, whatever the app last recorded.
const NOT_CONNECTED = /no\s+(?:active\s+|connected\s+)?(?:connected\s+)?(?:account|connection)s?\b|not\s+(?:been\s+)?connected|connected\s+account\b[^.]{0,60}\b(?:not\s+found|inactive|disabled|expired|missing)|no\s+active\s+connection/i;
const BAD_REQUEST = /invalid\s+request\s+data|missing\s+required|invalid\s+(?:argument|parameter|request)|malformed/i;
const TIMEOUT = /time(?:d)?[\s-]?out|etimedout|econnaborted|aborted|deadline/i;

export function classifyToolFailure(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  const status = Number(error?.httpStatus) || 0;
  const reason = String(error?.reason ?? "");

  if (code === "schema_rejected") return "bad_arguments";
  if (PLATFORM_KEY.test(message)) return "provider_failure";
  if (QUOTA_REASON.test(reason) || status === 429) return "quota";
  if (NOT_CONNECTED.test(message)) return "authorization_expired";
  if (AUTH_REASON.test(reason) || status === 401) return "authorization_expired";
  if (PERMISSION_REASON.test(reason) || status === 403) {
    // Some providers send quota as a 403 with the words only.
    return QUOTA.test(message) && !/insufficient|scope|permission/i.test(message) ? "quota" : "permission";
  }
  if (BAD_REQUEST_REASON.test(reason) || status === 400 || status === 422) return "bad_arguments";
  if (QUOTA.test(message)) return "quota";
  // Expiry is checked before permission: "401 invalid_grant" is not a scope problem.
  if (EXPIRED.test(message) && !/insufficient|scope|forbidden|\b403\b/i.test(message)) return "authorization_expired";
  if (PERMISSION.test(message)) return "permission";
  if (BAD_REQUEST.test(message)) return "bad_arguments";
  if (TIMEOUT.test(message) || TIMEOUT.test(code)) return "timeout";
  return "provider_failure";
}

const NEXT = "Do not guess the answer and do not say the account has no such data.";

/**
 * What the model is told. `reference` is the app's own request reference (what support can look up), never the provider's id.
 */
export function toolFailureContent(category, serviceName, { reference = null } = {}) {
  switch (category) {
    case "permission":
      return `${serviceName} is connected but did not allow this read with the current permissions. Tell the user to reconnect ${serviceName} in Extensions > Connectors and grant the missing access. ${NEXT}`;
    case "authorization_expired":
      return `${serviceName} sign-in has expired or was revoked. Tell the user to reconnect ${serviceName} in Extensions > Connectors. ${NEXT}`;
    case "quota":
      return `${serviceName}'s usage limit was reached, so no data was read. This is not a problem with the user's account and reconnecting will not help. Say ${serviceName} is at its usage limit and the user can try again later. ${NEXT}`;
    case "bad_arguments":
      return `${serviceName} rejected this request as malformed, so no data was read. This is a problem on our side, not the user's account. Say the lookup could not be completed and may be retried later. ${NEXT}`;
    case "timeout":
      return `${serviceName} did not respond in time, so no data was read. Say it timed out and the user can try again. ${NEXT}`;
    default:
      return `${serviceName} failed while reading this, so no data was returned. We could not identify the cause. Say the lookup could not be completed, do not promise that trying again will work${reference ? `, and give the user this reference so support can look into it: ${reference}` : ""}. ${NEXT}`;
  }
}
