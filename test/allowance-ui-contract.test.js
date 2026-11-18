import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAllowanceUiEnabled } from "../frontend/src/components/allowance/allowance-gate.js";
import {
  ALLOWANCE_LOAD_STATES,
  allowanceLoadErrorMessage,
  allowanceLoadErrorState,
  allowanceViewFromChatError,
  allowanceViewModel,
} from "../frontend/src/components/allowance/allowance-view.js";

function summary(overrides = {}) {
  return {
    plan: "plus",
    allowance: {
      currency: "USD",
      includedMicros: 5_000_000,
      confirmedMicros: 0,
      pendingMicros: 0,
      availableMicros: 5_000_000,
      display: { included: "$5.00", confirmed: "$0.00", pending: "$0.00", available: "$5.00" },
      periodStartedAt: "2026-10-15T00:00:00.000Z",
      resetAt: "2026-11-15T00:00:00.000Z",
      resetCadence: "monthly",
      billingTermExtendsBeyondReset: false,
      ...overrides.allowance,
    },
    paidUsage: { restricted: false, reason: null, ...overrides.paidUsage },
    freeChoices: overrides.freeChoices ?? [{ id: "vibhavgpt-lumen", modelKey: "lumen", displayName: "VibhavGPT Lumen", description: "Lightweight, simple tasks included on all accounts.", available: true, unavailableReason: null }],
    enforcementConnected: false,
    ...(overrides.plan ? { plan: overrides.plan } : {}),
  };
}

test("allowance UI gate is disabled by default and controllable via runtime/env flags", () => {
  delete globalThis.window;
  delete process.env.VITE_FEATURE_ALLOWANCE_UI;
  assert.equal(isAllowanceUiEnabled(), false);
  globalThis.window = {};
  assert.equal(isAllowanceUiEnabled(), false);
  globalThis.window.__VIBHAVGPT_FEATURE_ALLOWANCE_UI = true;
  assert.equal(isAllowanceUiEnabled(), true);
  globalThis.window.__VIBHAVGPT_FEATURE_ALLOWANCE_UI = false;
  assert.equal(isAllowanceUiEnabled(), false);
  delete globalThis.window;
});

test("headline uses server display amounts for Plus $5, Pro $12, Max $30", () => {
  const cases = [["plus", "Plus", "$5.00"], ["pro", "Pro", "$12.00"], ["max", "Max", "$30.00"]];
  for (const [plan, label, amount] of cases) {
    const view = allowanceViewModel(summary({ plan, allowance: { display: { included: amount, confirmed: "$0.00", pending: "$0.00", available: amount } } }));
    assert.equal(view.planLabel, label);
    assert.equal(view.headline, `${amount} remaining of ${amount}`);
    assert.equal(view.statusText, "Available");
    assert.equal(view.restriction, null);
  }
});

test("view model never recomputes amounts: it shows exactly what the server sent", () => {
  // Deliberately inconsistent figures prove the UI does not do its own arithmetic.
  const view = allowanceViewModel(summary({ allowance: { display: { included: "$5.00", confirmed: "$9.99", pending: "$0.00", available: "$1.23" } } }));
  assert.equal(view.headline, "$1.23 remaining of $5.00");
  assert.equal(view.confirmed, "$9.99");
});

test("pending reservations are explained and shown separately from confirmed spending", () => {
  const view = allowanceViewModel(summary({
    allowance: {
      confirmedMicros: 1_334_567,
      pendingMicros: 90_000,
      availableMicros: 3_575_433,
      display: { included: "$5.00", confirmed: "$1.34", pending: "$0.09", available: "$3.57" },
    },
  }));
  assert.equal(view.hasPending, true);
  assert.equal(view.confirmed, "$1.34");
  assert.equal(view.pending, "$0.09");
  assert.match(view.pendingNote, /\$0\.09 is reserved for requests that are still finishing/);
  assert.match(view.pendingNote, /isn't counted as spent/);
  assert.ok(view.confirmedShare > 26 && view.confirmedShare < 27);
  assert.ok(view.pendingShare > 1 && view.pendingShare < 2);
  assert.match(view.meterLabel, /\$1\.34 spent, \$0\.09 pending, \$3\.57 remaining of \$5\.00/);

  const none = allowanceViewModel(summary());
  assert.equal(none.pendingNote, null);
  assert.equal(none.hasPending, false);
});

test("annual plans explain the monthly allowance reset", () => {
  const view = allowanceViewModel(summary({ plan: "pro", allowance: { billingTermExtendsBeyondReset: true, resetAt: "2026-02-28T12:00:00.000Z" } }), { locale: "en-US", timeZone: "UTC" });
  assert.match(view.monthlyGrantNote, /refreshes every month/);
  assert.equal(view.resetDate, "February 28, 2026");
  assert.equal(view.resetLabel, "Resets February 28, 2026");
  assert.equal(allowanceViewModel(summary()).monthlyGrantNote, null);
});

test("exhausted and pending-hold restrictions use distinct, color-independent text", () => {
  const exhausted = allowanceViewModel(summary({
    allowance: { availableMicros: 0, confirmedMicros: 5_000_000, display: { included: "$5.00", confirmed: "$5.00", pending: "$0.00", available: "$0.00" } },
    paidUsage: { restricted: true, reason: "allowance_exhausted" },
  }));
  assert.equal(exhausted.headline, "$0.00 remaining of $5.00");
  assert.equal(exhausted.statusText, "Used up");
  assert.equal(exhausted.restrictionTitle, "Paid allowance used up");
  // While chat is disconnected the copy must not claim paid models are paused today.
  assert.match(exhausted.restrictionBody, /Once the allowance applies to chat, paid models will pause/);
  assert.match(exhausted.restrictionBody, /nothing will be charged to your card/);
  assert.match(exhausted.restrictionBody, /Chat isn't affected today/);
  assert.doesNotMatch(exhausted.restrictionBody, /models are paused/);
  const connected = allowanceViewModel({ ...summary({ paidUsage: { restricted: true, reason: "allowance_exhausted" } }), enforcementConnected: true });
  assert.match(connected.restrictionBody, /models that use it are paused\. Nothing is charged to your card/);
  assert.equal(exhausted.confirmedShare, 100);
  assert.equal(exhausted.pendingShare, 0);

  const held = allowanceViewModel(summary({ paidUsage: { restricted: true, reason: "pending_usage_holds" } }));
  assert.equal(held.statusText, "On hold");
  assert.match(held.restrictionBody, /any unused part is returned/);
  assert.match(held.restrictionBody, /Chat isn't affected today/);
});

test("free accounts and unavailable free choices are presented honestly", () => {
  const free = allowanceViewModel({ plan: "free", allowance: null, paidUsage: { restricted: true, reason: "no_paid_allowance" }, freeChoices: [], enforcementConnected: false });
  assert.equal(free.kind, "no_allowance");
  assert.equal(free.planLabel, "Free");
  assert.match(free.headline, /Plus, Pro, and Max/);

  const unavailable = allowanceViewModel(summary({
    paidUsage: { restricted: true, reason: "allowance_exhausted" },
    freeChoices: [{ id: "vibhavgpt-lumen", modelKey: "lumen", displayName: "VibhavGPT Lumen", description: "x", available: false, unavailableReason: "This model is temporarily unavailable." }],
  }));
  assert.equal(unavailable.freeChoices[0].available, false);
});

test("load errors map to session-expired, disabled, network, and server states", () => {
  assert.equal(allowanceLoadErrorState({ status: 401 }), ALLOWANCE_LOAD_STATES.SESSION_EXPIRED);
  assert.equal(allowanceLoadErrorState({ status: 404, code: "feature_disabled" }), ALLOWANCE_LOAD_STATES.DISABLED);
  assert.equal(allowanceLoadErrorState({ status: 500 }), ALLOWANCE_LOAD_STATES.ERROR);
  assert.equal(allowanceLoadErrorState({ code: "network-error" }), ALLOWANCE_LOAD_STATES.ERROR);
  assert.match(allowanceLoadErrorMessage(ALLOWANCE_LOAD_STATES.SESSION_EXPIRED), /session has expired/i);
  assert.match(allowanceLoadErrorMessage(ALLOWANCE_LOAD_STATES.ERROR, { code: "network-error" }), /connection/i);
  assert.match(allowanceLoadErrorMessage(ALLOWANCE_LOAD_STATES.ERROR, { status: 500 }), /couldn't load/i);
});

test("the note says exactly which models use the allowance, and never claims more", () => {
  assert.match(allowanceViewModel(summary()).previewNote, /chat doesn't apply this allowance yet/);
  assert.equal(allowanceViewModel({ ...summary(), enforcementConnected: true }).previewNote, null, "connected with no named model claims nothing");
  const one = allowanceViewModel({ ...summary(), enforcementConnected: true, enforcedModels: [{ modelKey: "nova", displayName: "VibhavGPT Nova" }] });
  assert.equal(one.previewNote, "Applies to VibhavGPT Nova. Other models keep your existing plan limits.");
  assert.doesNotMatch(one.previewNote, /doesn't apply/);
  const two = allowanceViewModel({ ...summary(), enforcementConnected: true, enforcedModels: [{ displayName: "VibhavGPT Nova" }, { displayName: "VibhavGPT Vulcan" }] });
  assert.match(two.previewNote, /^Applies to VibhavGPT Nova, VibhavGPT Vulcan\./);
});

test("a chat refusal becomes a notice view with the server's wording and choices, and nothing else", () => {
  const error = Object.assign(new Error("Your included AI allowance is used up for this period."), {
    code: "allowance_exceeded",
    allowance: { paidModelRestricted: true, reason: "allowance_exhausted", resetAt: "2026-11-14T12:00:00.000Z", freeChoices: [{ id: "vibhavgpt-lumen", modelKey: "lumen", displayName: "VibhavGPT Lumen", description: "x", available: true, unavailableReason: null }] },
  });
  const view = allowanceViewFromChatError(error, { locale: "en-US", timeZone: "UTC" });
  assert.equal(view.kind, "subscription");
  assert.equal(view.restrictionTitle, "Paid allowance used up");
  assert.equal(view.restrictionBody, error.message);
  assert.equal(view.resetDate, "November 14, 2026");
  assert.deepEqual(view.freeChoices.map((choice) => [choice.modelKey, choice.available]), [["lumen", true]]);
  const held = allowanceViewFromChatError({ ...error, allowance: { ...error.allowance, reason: "pending_usage_holds" } });
  assert.equal(held.restrictionTitle, "Remaining allowance is on hold");
  const small = allowanceViewFromChatError({ ...error, allowance: { ...error.allowance, reason: "request_exceeds_remaining" } });
  assert.equal(small.restrictionTitle, "Not enough allowance for this request");
  assert.equal(allowanceViewFromChatError(new Error("other")), null);
  assert.equal(allowanceViewFromChatError({ allowance: { paidModelRestricted: false } }), null);
});

test("components never switch models or send messages on their own", async () => {
  const notice = await readFile(new URL("../frontend/src/components/allowance/AllowanceExhaustedNotice.jsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../frontend/src/components/allowance/AllowancePanel.jsx", import.meta.url), "utf8");
  const hook = await readFile(new URL("../frontend/src/components/allowance/useAllowanceSummary.js", import.meta.url), "utf8");
  // The only call of the choice handler is inside an explicit click handler.
  assert.equal(notice.match(/onChooseFreeModel\(/g)?.length, 1);
  assert.match(notice, /onClick=\{\(\) => onChooseFreeModel\(choice\)\}/);
  for (const source of [notice, panel, hook]) {
    assert.doesNotMatch(source, /\/api\/chat|\/api\/profile|setModel|preferredModel|localStorage|sessionStorage/);
  }
  // The hook only reads the summary endpoint.
  assert.deepEqual(hook.match(/api\("[^"]+"/g), ['api("/api/usage/allowance"']);
  assert.doesNotMatch(hook, /method:/);
});

test("app mounts the allowance panel only behind the UI gate on the usage page", async () => {
  const app = await readFile(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
  const mounts = app.match(/<AllowancePanel\b[^>]*>/g) ?? [];
  assert.equal(mounts.length, 1);
  assert.match(app, /\{isAllowanceUiEnabled\(\) && userId && <AllowancePanel key=\{userId\} userId=\{userId\} \/>\}/);
  // The chat offers the included models only as explicit choices: one click handler, which changes the
  // selected model and does not send anything. Sending again is a separate, explicit button.
  const chatNotices = app.match(/<AllowanceExhaustedNotice[^\n]*/g) ?? [];
  assert.equal(chatNotices.length, 1);
  assert.match(chatNotices[0], /onChooseFreeModel=\{\(choice\) => changeModel\(choice\.modelKey\)\}/);
  assert.doesNotMatch(chatNotices[0], /deliver\(|startTurn\(|send\(/, "choosing a model never sends");
  assert.match(app, /Send again with \{MODELS\.find/, "re-sending is its own explicit button");
});
