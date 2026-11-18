/**
 * Opens connector authorization in a separate tab without navigating away
 * from VibhavGPT.
 *
 * Important: do NOT pass noopener/noreferrer to window.open for the pending
 * tab. Those features make window.open return null in modern browsers, so the
 * blank tab cannot be navigated and is left stranded at about:blank.
 *
 * Pattern: open a same-gesture tab → show a brief loading document → call
 * initiate → navigate the retained handle to a validated HTTPS auth URL.
 */

const DEFAULT_TRUSTED_HOST_SUFFIXES = Object.freeze([
  "composio.dev",
  "accounts.google.com",
  "github.com",
  "login.microsoftonline.com",
  "slack.com",
  "notion.so",
  "notion.com",
  "atlassian.com",
  "auth.atlassian.com",
  "linear.app",
  "trello.com",
  "dropbox.com",
  "airtable.com",
  "gitlab.com",
]);

const PENDING_AUTH_DOCUMENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connecting…</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0f1115; color: #e8eaed;
      font: 15px/1.45 system-ui, sans-serif; }
    main { min-height: 100%; display: grid; place-items: center; padding: 24px; text-align: center; }
    p { margin: 8px 0 0; opacity: 0.78; max-width: 28rem; }
    .pulse { width: 28px; height: 28px; margin: 0 auto 14px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.22); border-top-color: #8ab4f8;
      animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <div>
      <div class="pulse" aria-hidden="true"></div>
      <strong>Connecting your account</strong>
      <p>Stay on this tab. Authorization will open here in a moment.</p>
    </div>
  </main>
</body>
</html>`;

export function isTrustedAuthRedirectUrl(url, extraHosts = []) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    const allowed = [
      ...DEFAULT_TRUSTED_HOST_SUFFIXES,
      ...extraHosts.map((h) => String(h).toLowerCase()),
    ];
    return allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function closeAuthTab(authTab) {
  if (!authTab || authTab.closed) return;
  try {
    authTab.close();
  } catch {
    /* ignore */
  }
}

function writePendingDocument(authTab) {
  if (!authTab || authTab.closed) return false;
  try {
    authTab.document.open();
    authTab.document.write(PENDING_AUTH_DOCUMENT);
    authTab.document.close();
    return true;
  } catch {
    return false;
  }
}

function navigateAuthTab(authTab, redirectUrl) {
  if (!authTab || authTab.closed) return false;
  try {
    // Prefer replace so the loading document is not left in history.
    if (authTab.location && typeof authTab.location.replace === "function") {
      authTab.location.replace(redirectUrl);
    } else {
      authTab.location.href = redirectUrl;
    }
    // Drop opener after we successfully hand off to the provider page.
    try {
      authTab.opener = null;
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {() => Promise<{ redirectUrl?: string, connected?: boolean, attemptId?: string, connectionId?: string, error?: string }>} options.initiate
 * @param {(message: string) => void} [options.onBlocked]
 * @param {(message: string) => void} [options.onError]
 * @returns {Promise<{ opened: boolean, connected: boolean, attemptId: string|null, connectionId: string|null, redirectUrl: string|null, blocked: boolean }>}
 */
export async function openConnectorAuthorization({ initiate, onBlocked, onError } = {}) {
  if (typeof initiate !== "function") {
    throw new Error("openConnectorAuthorization requires an initiate() function.");
  }

  // Open synchronously from the click gesture. Do not use noopener/noreferrer —
  // those make window.open return null and strand an about:blank tab.
  let authTab = null;
  try {
    authTab = window.open("about:blank", "_blank");
  } catch {
    authTab = null;
  }

  if (authTab && !authTab.closed) {
    writePendingDocument(authTab);
  }

  let result;
  try {
    result = await initiate();
  } catch (err) {
    closeAuthTab(authTab);
    onError?.(err?.message || "Could not start authorization.");
    throw err;
  }

  if (result?.connected) {
    closeAuthTab(authTab);
    return {
      opened: false,
      connected: true,
      attemptId: result.attemptId || null,
      connectionId: result.connectionId || null,
      redirectUrl: null,
      blocked: false,
    };
  }

  const redirectUrl = result?.redirectUrl || null;
  if (!redirectUrl) {
    closeAuthTab(authTab);
    const message = result?.error || "Authorization did not return a redirect URL.";
    onError?.(message);
    throw new Error(message);
  }

  if (!isTrustedAuthRedirectUrl(redirectUrl)) {
    closeAuthTab(authTab);
    const message = "Authorization URL was rejected because it is not a trusted host.";
    onError?.(message);
    throw new Error(message);
  }

  if (authTab && !authTab.closed && navigateAuthTab(authTab, redirectUrl)) {
    return {
      opened: true,
      connected: false,
      attemptId: result.attemptId || null,
      connectionId: result.connectionId || null,
      redirectUrl,
      blocked: false,
    };
  }

  // Popup blocked or retained-handle navigation failed — never navigate the app tab.
  closeAuthTab(authTab);
  onBlocked?.(redirectUrl);
  return {
    opened: false,
    connected: false,
    attemptId: result.attemptId || null,
    connectionId: result.connectionId || null,
    redirectUrl,
    blocked: true,
  };
}

/**
 * Bounded polling helper for authorization completion.
 * Stops on connected, cancelled, expiry, or unmount (via signal).
 */
export function pollConnectorAuthorization({
  checkStatus,
  intervalMs = 2500,
  timeoutMs = 15 * 60 * 1000,
  signal,
  onUpdate,
} = {}) {
  if (typeof checkStatus !== "function") {
    return Promise.reject(new Error("pollConnectorAuthorization requires checkStatus()."));
  }

  const started = Date.now();
  let timer = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };

  if (signal) {
    if (signal.aborted) {
      return Promise.resolve({ status: "cancelled" });
    }
    signal.addEventListener("abort", stop, { once: true });
  }

  return new Promise((resolve) => {
    const tick = async () => {
      if (stopped) {
        resolve({ status: "cancelled" });
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        stop();
        resolve({ status: "expired" });
        return;
      }
      try {
        const status = await checkStatus();
        onUpdate?.(status);
        if (status?.status === "connected") {
          stop();
          resolve(status);
          return;
        }
        if (status?.status === "cancelled" || status?.status === "expired") {
          stop();
          resolve(status);
          return;
        }
      } catch {
        // Keep polling through transient errors.
      }
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
  });
}
