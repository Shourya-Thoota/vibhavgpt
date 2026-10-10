import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import express from "express";
import { createNativeOAuthRouter } from "../src/auth/native-oauth.js";

const BASE = "https://api.vibhavgpt.com";
const SESSION = "__Secure-better-auth.session_token";
const TWO_FACTOR = "__Secure-better-auth.two_factor";
const cookieAttributes = { secure: true, sameSite: "lax", path: "/", httpOnly: true };

function fakeAuth() {
  const store = new Map();
  const signInCalls = [];
  const context = {
    authCookies: {
      sessionToken: { name: SESSION, attributes: { ...cookieAttributes, maxAge: 604800 } },
      dontRememberToken: { name: "__Secure-better-auth.dont_remember", attributes: cookieAttributes },
    },
    createAuthCookie: (name, overrides) => ({ name: `__Secure-better-auth.${name}`, attributes: { ...cookieAttributes, ...overrides } }),
    internalAdapter: {
      createVerificationValue: async (record) => { store.set(record.identifier, { ...record }); },
      consumeVerificationValue: async (identifier) => {
        const record = store.get(identifier) ?? null;
        store.delete(identifier);
        return record;
      },
    },
  };
  return {
    store,
    signInCalls,
    auth: {
      $context: Promise.resolve(context),
      api: {
        signInSocial: async ({ body }) => {
          signInCalls.push(body);
          return { url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc", redirect: false };
        },
      },
    },
  };
}

async function withServer(fake, run) {
  const app = express();
  app.use("/api/native-auth", createNativeOAuthRouter({ auth: fake.auth, authBaseUrl: BASE, limiter: (_req, _res, next) => next() }));
  const server = app.listen(0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    server.close();
  }
}

const verifier = "v".repeat(43);
const verifierHash = createHash("sha256").update(verifier).digest("base64url");
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function startAndFinish(origin, fake, { cookie, query = "" }) {
  const start = await post(`${origin}/api/native-auth/google/start`, { verifierHash });
  assert.equal(start.status, 200);
  const { url } = await start.json();
  const handoff = new URL(fake.signInCalls.at(-1).callbackURL).searchParams.get("handoff");
  const finish = await fetch(`${origin}/api/native-auth/finish?handoff=${handoff}${query}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return { url, finish, handoff };
}

test("native Google sign-in hands the browser session to the app only with the verifier", async () => {
  const fake = fakeAuth();
  await withServer(fake, async (origin) => {
    const { url, finish } = await startAndFinish(origin, fake, { cookie: `${SESSION}=tok.sig%2Fx; other=1` });

    const proxy = new URL(url);
    assert.equal(proxy.origin + proxy.pathname, `${BASE}/api/auth/expo-authorization-proxy`);
    assert.equal(proxy.searchParams.get("authorizationURL"), "https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    assert.equal(fake.signInCalls[0].errorCallbackURL, fake.signInCalls[0].callbackURL);

    assert.equal(finish.status, 302);
    const back = new URL(finish.headers.get("location"));
    assert.equal(`${back.protocol}//${back.host}${back.pathname}`, "vibhavgpt://account/auth");
    const code = back.searchParams.get("code");
    assert.ok(code);
    // The external browser's copy of the session is cleared.
    assert.match(finish.headers.get("set-cookie"), new RegExp(`${SESSION}=;`));

    const wrong = await post(`${origin}/api/native-auth/exchange`, { code, verifier: "w".repeat(43) });
    assert.equal(wrong.status, 400);
    // A failed attempt burns the code.
    const retry = await post(`${origin}/api/native-auth/exchange`, { code, verifier });
    assert.equal(retry.status, 400);
  });
});

test("the exchange sets the exact signed session cookie once", async () => {
  const fake = fakeAuth();
  await withServer(fake, async (origin) => {
    const { finish } = await startAndFinish(origin, fake, { cookie: `${SESSION}=tok.sig%2Fx` });
    const code = new URL(finish.headers.get("location")).searchParams.get("code");

    const exchange = await post(`${origin}/api/native-auth/exchange`, { code, verifier });
    assert.equal(exchange.status, 200);
    const setCookie = exchange.headers.get("set-cookie");
    assert.match(setCookie, new RegExp(`^${SESSION}=tok\\.sig%2Fx;`));
    assert.match(setCookie, /Max-Age=604800/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.deepEqual((await exchange.json()).params, {});

    const again = await post(`${origin}/api/native-auth/exchange`, { code, verifier });
    assert.equal(again.status, 400);
  });
});

test("a 2FA challenge is handed over with its parameters", async () => {
  const fake = fakeAuth();
  await withServer(fake, async (origin) => {
    const { finish } = await startAndFinish(origin, fake, {
      cookie: `${TWO_FACTOR}=id.sig`,
      query: "&twoFactorRequired=true&twoFactor=required&twoFactorMethods=totp&evil=1",
    });
    const code = new URL(finish.headers.get("location")).searchParams.get("code");
    const exchange = await post(`${origin}/api/native-auth/exchange`, { code, verifier });
    assert.equal(exchange.status, 200);
    assert.match(exchange.headers.get("set-cookie"), new RegExp(`^${TWO_FACTOR}=id\\.sig;`));
    assert.deepEqual((await exchange.json()).params, { twoFactorRequired: "true", twoFactor: "required", twoFactorMethods: "totp" });
  });
});

test("OAuth errors, missing sessions and reused handoffs return to the app with an error", async () => {
  const fake = fakeAuth();
  await withServer(fake, async (origin) => {
    const denied = await startAndFinish(origin, fake, { cookie: `${SESSION}=tok.sig`, query: "&error=access_denied" });
    assert.equal(new URL(denied.finish.headers.get("location")).searchParams.get("error"), "access_denied");

    const reused = await fetch(`${origin}/api/native-auth/finish?handoff=${denied.handoff}`, { redirect: "manual", headers: { cookie: `${SESSION}=tok.sig` } });
    assert.equal(new URL(reused.headers.get("location")).searchParams.get("error"), "expired");

    const noSession = await startAndFinish(origin, fake, {});
    assert.equal(new URL(noSession.finish.headers.get("location")).searchParams.get("error"), "no_session");
  });
});

test("start rejects a malformed verifier hash", async () => {
  const fake = fakeAuth();
  await withServer(fake, async (origin) => {
    const response = await post(`${origin}/api/native-auth/google/start`, { verifierHash: "short" });
    assert.equal(response.status, 400);
    assert.equal(fake.signInCalls.length, 0);
  });
});
