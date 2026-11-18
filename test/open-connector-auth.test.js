/**
 * Unit coverage for separate-tab Connect helpers.
 * These are deterministic stubs — they do NOT establish live OAuth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isTrustedAuthRedirectUrl,
  openConnectorAuthorization,
  pollConnectorAuthorization,
} from "../frontend/src/components/extensions/openConnectorAuth.js";

function makeFakeTab() {
  const tab = {
    closed: false,
    opener: {},
    location: {
      href: "about:blank",
      replace(url) {
        this.href = url;
      },
    },
    document: {
      open() {},
      write() {
        tab._wrotePending = true;
      },
      close() {},
    },
    close() {
      this.closed = true;
    },
  };
  return tab;
}

test("isTrustedAuthRedirectUrl accepts known HTTPS hosts only", () => {
  assert.equal(isTrustedAuthRedirectUrl("https://accounts.google.com/o/oauth2"), true);
  assert.equal(isTrustedAuthRedirectUrl("https://backend.composio.dev/auth"), true);
  assert.equal(isTrustedAuthRedirectUrl("https://connect.composio.dev/link"), true);
  assert.equal(isTrustedAuthRedirectUrl("http://accounts.google.com/o/oauth2"), false);
  assert.equal(isTrustedAuthRedirectUrl("https://evil.example/phish"), false);
  assert.equal(isTrustedAuthRedirectUrl("javascript:alert(1)"), false);
});

test("openConnectorAuthorization retains the tab handle and navigates it to the validated URL", async () => {
  const openArgs = [];
  const fakeTab = makeFakeTab();
  globalThis.window = {
    open(...args) {
      openArgs.push(args);
      return fakeTab;
    },
  };

  const redirectUrl = "https://accounts.google.com/o/oauth2/auth?client=stub";
  const result = await openConnectorAuthorization({
    initiate: async () => ({
      redirectUrl,
      attemptId: "att_stub_1",
    }),
  });

  // Must NOT pass noopener/noreferrer — that returns null and strands about:blank.
  assert.equal(openArgs.length, 1);
  assert.equal(openArgs[0][0], "about:blank");
  assert.equal(openArgs[0][1], "_blank");
  assert.equal(openArgs[0][2], undefined, "noopener/noreferrer must not be used");

  assert.equal(fakeTab._wrotePending, true, "pending loading document written");
  assert.equal(fakeTab.location.href, redirectUrl, "tab must navigate to auth destination");
  assert.equal(fakeTab.opener, null, "opener dropped after handoff");
  assert.equal(fakeTab.closed, false, "auth tab stays open for consent");
  assert.equal(result.opened, true);
  assert.equal(result.blocked, false);
  assert.equal(result.redirectUrl, redirectUrl);
  assert.equal(result.attemptId, "att_stub_1");
  assert.equal(result.connected, false, "stub initiate does not claim live OAuth connected");
});

test("openConnectorAuthorization closes blank tab and surfaces error when initiate fails", async () => {
  const fakeTab = makeFakeTab();
  globalThis.window = { open: () => fakeTab };

  await assert.rejects(
    () =>
      openConnectorAuthorization({
        initiate: async () => {
          throw new Error("initiate boom");
        },
      }),
    /initiate boom/,
  );
  assert.equal(fakeTab.closed, true);
});

test("openConnectorAuthorization closes blank tab when redirect host is untrusted", async () => {
  const fakeTab = makeFakeTab();
  const errors = [];
  globalThis.window = { open: () => fakeTab };

  await assert.rejects(
    () =>
      openConnectorAuthorization({
        initiate: async () => ({ redirectUrl: "https://evil.example/phish" }),
        onError: (m) => errors.push(m),
      }),
    /trusted host/i,
  );
  assert.equal(fakeTab.closed, true);
  assert.match(errors[0] || "", /trusted host/i);
});

test("openConnectorAuthorization reports blocked without navigating the app tab", async () => {
  const blockedUrls = [];
  globalThis.window = {
    open() {
      return null; // popup blocked
    },
  };

  const result = await openConnectorAuthorization({
    initiate: async () => ({
      redirectUrl: "https://accounts.google.com/o/oauth2/auth?client=stub",
      attemptId: "att_blocked",
    }),
    onBlocked: (url) => blockedUrls.push(url),
  });

  assert.equal(result.blocked, true);
  assert.equal(result.opened, false);
  assert.equal(blockedUrls.length, 1);
});

test("openConnectorAuthorization recovers when retained-handle navigation throws", async () => {
  const blockedUrls = [];
  const fakeTab = makeFakeTab();
  fakeTab.location.replace = () => {
    throw new Error("cross-origin block");
  };
  Object.defineProperty(fakeTab.location, "href", {
    set() {
      throw new Error("cross-origin block");
    },
    get() {
      return "about:blank";
    },
  });
  globalThis.window = { open: () => fakeTab };

  const result = await openConnectorAuthorization({
    initiate: async () => ({
      redirectUrl: "https://connect.composio.dev/auth?stub=1",
    }),
    onBlocked: (url) => blockedUrls.push(url),
  });

  assert.equal(result.blocked, true);
  assert.equal(fakeTab.closed, true, "stranded blank tab must be closed");
  assert.equal(blockedUrls.length, 1);
});

test("pollConnectorAuthorization resolves expired / cancelled / connected", async () => {
  const expired = await pollConnectorAuthorization({
    checkStatus: async () => ({ status: "pending_auth" }),
    intervalMs: 5,
    timeoutMs: 20,
  });
  assert.equal(expired.status, "expired");

  const controller = new AbortController();
  controller.abort();
  const cancelled = await pollConnectorAuthorization({
    checkStatus: async () => ({ status: "pending_auth" }),
    signal: controller.signal,
  });
  assert.equal(cancelled.status, "cancelled");

  let ticks = 0;
  const connected = await pollConnectorAuthorization({
    checkStatus: async () => {
      ticks += 1;
      return ticks >= 2
        ? { status: "connected", fullyAuthorized: false, scopeVerification: "unverified" }
        : { status: "pending_auth" };
    },
    intervalMs: 5,
    timeoutMs: 1000,
  });
  assert.equal(connected.status, "connected");
  assert.equal(connected.fullyAuthorized, false, "connected ≠ fullyAuthorized without scope evidence");
});
