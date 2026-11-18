import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CARRY_MODES,
  CREDIT_MICROS,
  MONTHLY_CREDITS,
  allocationSchedule,
  computeCreditBalance,
  creditsPhrase,
  formatCredits,
  monthlyAllowanceMicros,
  monthlyCreditsFor,
  normalizeCarryMode,
  typicalWeeklyAllocation,
  windowIndexAt,
  wholeCreditsPhrase,
} from "../frontend/src/credits-policy.js";
import { SUBSCRIPTION_PLAN_LIMITS } from "../src/models/pricing-engine.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const PLANS = ["free", "plus", "pro", "max"];
const schedule = (monthly, days, start = Date.UTC(2026, 3, 1)) =>
  allocationSchedule({ periodStart: start, periodEnd: start + days * DAY, monthlyCredits: monthly });
const credits = (s) => s.windows.map((window) => window.credits);

// ---- Conversion --------------------------------------------------------------

test("one credit is 50,000 micro-dollars and the monthly totals are the existing allowance, exactly", () => {
  assert.equal(CREDIT_MICROS, 50_000);
  assert.deepEqual(MONTHLY_CREDITS, { free: 5, plus: 60, pro: 180, max: 800 });
  assert.deepEqual(PLANS.map((plan) => monthlyAllowanceMicros(plan)), [250_000, 3_000_000, 9_000_000, 40_000_000]);
  // Credits restate the allowance the ledger already enforces; they are not a new budget.
  for (const plan of PLANS) assert.equal(monthlyAllowanceMicros(plan), SUBSCRIPTION_PLAN_LIMITS[plan].mtabMicros, `${plan} matches the existing monthly budget`);
  assert.equal(monthlyCreditsFor("paid"), 180, "the legacy paid tier is Pro");
  assert.equal(monthlyCreditsFor("unknown"), 5);
});

test("allocations are whole credits and whole micro-dollars", () => {
  for (const plan of PLANS) {
    for (const days of [28, 29, 30, 31]) {
      for (const window of schedule(monthlyCreditsFor(plan), days).windows) {
        assert.ok(Number.isInteger(window.credits) && window.credits >= 0, `${plan}/${days}d window ${window.index}`);
        assert.equal(window.micros, window.credits * CREDIT_MICROS);
        assert.ok(Number.isSafeInteger(window.micros));
      }
    }
  }
  assert.throws(() => schedule(2.5, 30), /whole number/);
  assert.throws(() => schedule(-1, 30), /whole number/);
});

// ---- Weekly windows ------------------------------------------------------------

test("the approved 30-day examples", () => {
  assert.deepEqual(credits(schedule(5, 30)), [1, 1, 1, 1, 1]);
  assert.deepEqual(credits(schedule(60, 30)), [14, 14, 14, 14, 4]);
  assert.deepEqual(credits(schedule(180, 30)), [42, 42, 42, 42, 12]);
  assert.deepEqual(credits(schedule(800, 30)), [187, 187, 187, 187, 52]);
  assert.deepEqual(PLANS.map((plan) => typicalWeeklyAllocation(plan)), [[1, 1, 1, 1, 1], [14, 14, 14, 14, 4], [42, 42, 42, 42, 12], [187, 187, 187, 187, 52]]);
});

test("28-day periods: the fourth full week is the final window and takes the remainder", () => {
  assert.deepEqual(credits(schedule(5, 28)), [1, 1, 1, 2], "Free: 1, 1, 1 then the remaining 2");
  assert.deepEqual(credits(schedule(60, 28)), [15, 15, 15, 15]);
  assert.deepEqual(credits(schedule(180, 28)), [45, 45, 45, 45]);
  assert.deepEqual(credits(schedule(800, 28)), [200, 200, 200, 200]);
  const free = schedule(5, 28);
  assert.equal(free.windows.length, 4);
  assert.equal(free.windows[3].isFinal, true);
  assert.equal(free.windows[3].endMs - free.windows[3].startMs, WEEK, "the final window is a full seven days here");
});

test("29 and 31-day periods end in a partial window with the exact remainder", () => {
  assert.deepEqual(credits(schedule(60, 29)), [14, 14, 14, 14, 4]);
  assert.deepEqual(credits(schedule(180, 29)), [43, 43, 43, 43, 8]);
  assert.deepEqual(credits(schedule(800, 29)), [193, 193, 193, 193, 28]);
  assert.deepEqual(credits(schedule(60, 31)), [14, 14, 14, 14, 4]);
  assert.deepEqual(credits(schedule(180, 31)), [41, 41, 41, 41, 16]);
  assert.deepEqual(credits(schedule(800, 31)), [181, 181, 181, 181, 76]);
  assert.equal(schedule(60, 29).windows[4].endMs - schedule(60, 29).windows[4].startMs, 1 * DAY);
  assert.equal(schedule(60, 31).windows[4].endMs - schedule(60, 31).windows[4].startMs, 3 * DAY);
});

test("for every plan and every month length: the windows add up to the month, never a fifth full week", () => {
  const expectedFullWeek = (monthly, days) => Math.round((monthly * 7) / days);
  for (const plan of PLANS) {
    const monthly = monthlyCreditsFor(plan);
    for (const days of [28, 29, 30, 31]) {
      const s = schedule(monthly, days);
      assert.equal(s.windows.reduce((sum, window) => sum + window.credits, 0), monthly, `${plan}/${days}d total`);
      assert.equal(s.windows.length, Math.ceil(days / 7), `${plan}/${days}d window count`);
      assert.equal(s.fullWeekCredits, expectedFullWeek(monthly, days), `${plan}/${days}d full-week formula`);
      const fullWeeksGranted = s.windows.filter((window, i) => i < s.windows.length - 1).every((window) => window.credits <= s.fullWeekCredits);
      assert.ok(fullWeeksGranted, `${plan}/${days}d: no early window exceeds the full-week allocation`);
      assert.equal(s.windows.at(-1).cumulativeCredits, monthly);
    }
  }
});

test("windows tile the period exactly: contiguous, half-open, ending where the period ends", () => {
  for (const days of [28, 29, 30, 31]) {
    const s = schedule(60, days);
    assert.equal(s.windows[0].startMs, s.startMs);
    assert.equal(s.windows.at(-1).endMs, s.endMs);
    s.windows.forEach((window, i) => {
      if (i) assert.equal(window.startMs, s.windows[i - 1].endMs, `no gap or overlap at window ${i}`);
      assert.equal(window.index, i);
    });
  }
});

test("real calendar months, including a leap February", () => {
  const month = (year, m) => allocationSchedule({ periodStart: Date.UTC(year, m, 1), periodEnd: Date.UTC(year, m + 1, 1), monthlyCredits: 5 });
  assert.equal(month(2028, 1).days, 29, "February 2028 is a leap month");
  assert.deepEqual(credits(month(2028, 1)), [1, 1, 1, 1, 1]);
  assert.equal(month(2026, 1).days, 28);
  assert.deepEqual(credits(month(2026, 1)), [1, 1, 1, 2]);
  assert.equal(month(2026, 0).days, 31);
  assert.equal(month(2026, 3).days, 30);
  const plusLeap = allocationSchedule({ periodStart: Date.UTC(2028, 1, 1), periodEnd: Date.UTC(2028, 2, 1), monthlyCredits: 60 });
  assert.deepEqual(credits(plusLeap), [14, 14, 14, 14, 4]);
});

test("exact boundary timestamps fall in the later window; the period end is outside the period", () => {
  const s = schedule(60, 30);
  assert.equal(windowIndexAt(s, s.startMs - 1), -1);
  assert.equal(windowIndexAt(s, s.startMs), 0);
  for (let k = 1; k < s.windows.length; k += 1) {
    const boundary = s.windows[k].startMs;
    assert.equal(windowIndexAt(s, boundary - 1), k - 1, `1 ms before window ${k}`);
    assert.equal(windowIndexAt(s, boundary), k, `exactly at window ${k}`);
    assert.equal(windowIndexAt(s, new Date(boundary)), k, "a Date works as well");
  }
  assert.equal(windowIndexAt(s, s.endMs - 1), s.windows.length - 1);
  assert.equal(windowIndexAt(s, s.endMs), s.windows.length, "the end is exclusive");
});

test("timezone safety: windows are exact 7 x 24 h steps from UTC instants, across a US daylight-saving change", () => {
  const start = Date.parse("2026-03-01T00:00:00Z");
  const s = allocationSchedule({ periodStart: new Date(start), periodEnd: "2026-03-31T00:00:00Z", monthlyCredits: 60 });
  assert.deepEqual(s.windows.slice(0, 4).map((window) => window.endMs - window.startMs), [WEEK, WEEK, WEEK, WEEK]);
  // The same instants written with other offsets produce the same schedule.
  const shifted = allocationSchedule({ periodStart: "2026-02-28T19:00:00-05:00", periodEnd: "2026-03-30T20:00:00-04:00", monthlyCredits: 60 });
  assert.deepEqual(shifted.windows.map((window) => [window.startMs, window.endMs]), s.windows.map((window) => [window.startMs, window.endMs]));
});

test("the shared module uses no local-time calendar arithmetic", async () => {
  const source = await readFile(new URL("../frontend/src/credits-policy.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.(get|set)(Date|Hours|Month|FullYear|Day|Minutes)\(|toLocale|Intl\./, "only UTC instants and integer arithmetic");
  assert.doesNotMatch(source, /Math\.(random)|parseFloat/, "no float parsing in the allocation maths");
});

// ---- Activation inside a month ---------------------------------------------------

const APRIL = Date.UTC(2026, 3, 1);
const MAY = Date.UTC(2026, 4, 1);
const activated = (monthly, at, start = APRIL, end = MAY) => allocationSchedule({ periodStart: start, periodEnd: end, monthlyCredits: monthly, activatedAt: at });
const startsAt = (s) => new Date(s.startMs).toISOString();

test("activating at the start of the month changes nothing", () => {
  for (const plan of PLANS) {
    const plain = schedule(monthlyCreditsFor(plan), 30, APRIL);
    const at = activated(monthlyCreditsFor(plan), APRIL);
    assert.deepEqual(credits(at), credits(plain));
    assert.equal(at.foldedCredits, 0);
    assert.equal(at.firstWindowPartial, false);
    assert.equal(at.activatedAtMs, null, "no mid-period activation to report");
    assert.equal(at.startMs, APRIL);
  }
  // An activation instant before the month began is the month.
  assert.deepEqual(credits(activated(60, APRIL - 5 * DAY)), [14, 14, 14, 14, 4]);
});

test("mid-month activation: the first window is partial and the month's total is still exact", () => {
  const plus = activated(60, Date.UTC(2026, 3, 10, 12));
  assert.deepEqual(credits(plus), [28, 14, 14, 4], "week 1's 14 is folded into the partial week that holds the activation");
  assert.equal(credits(plus).reduce((sum, value) => sum + value, 0), 60, "exactly the monthly credits, never more or fewer");
  assert.equal(startsAt(plus), "2026-04-10T12:00:00.000Z", "the credit period begins at activation");
  assert.equal(new Date(plus.windows[0].endMs).toISOString(), "2026-04-15T00:00:00.000Z", "the week still ends on its fixed boundary");
  assert.equal(plus.firstWindowPartial, true);
  assert.equal(plus.foldedCredits, 14);
  assert.equal(new Date(plus.periodStartMs).toISOString(), "2026-04-01T00:00:00.000Z", "the calendar month is still the 1st");
  assert.deepEqual(credits(activated(5, Date.UTC(2026, 3, 10, 12))), [2, 1, 1, 1], "Free");
  assert.deepEqual(credits(activated(180, Date.UTC(2026, 3, 10, 12))), [84, 42, 42, 12], "Pro");
  assert.deepEqual(credits(activated(800, Date.UTC(2026, 3, 10, 12))), [374, 187, 187, 52], "Max");
  // The later windows are exactly the ordinary ones.
  assert.deepEqual(credits(plus).slice(1), credits(schedule(60, 30, APRIL)).slice(2));
});

test("activation on an exact week boundary folds the elapsed weeks and is not a partial week", () => {
  const onBoundary = activated(60, Date.UTC(2026, 3, 8));
  assert.deepEqual(credits(onBoundary), [28, 14, 14, 4]);
  assert.equal(startsAt(onBoundary), "2026-04-08T00:00:00.000Z");
  assert.equal(onBoundary.firstWindowPartial, false, "it starts with its week, so it is the full seven days");
  const oneMsLater = activated(60, Date.UTC(2026, 3, 8) + 1);
  assert.equal(oneMsLater.firstWindowPartial, true);
  // One millisecond before the boundary the instant is still in week 1: a one-millisecond partial
  // first window holding week 1's credits, then the ordinary weeks. Nothing is folded.
  const oneMsEarlier = activated(60, Date.UTC(2026, 3, 8) - 1);
  assert.deepEqual(credits(oneMsEarlier), [14, 14, 14, 14, 4]);
  assert.equal(oneMsEarlier.foldedCredits, 0);
  assert.equal(oneMsEarlier.windows[0].endMs - oneMsEarlier.windows[0].startMs, 1, "a one-millisecond first window");
  assert.equal(oneMsEarlier.windows[1].startMs, Date.UTC(2026, 3, 8));
});

test("activating in the final window gives the whole month in one window, still exact", () => {
  const late = activated(60, Date.UTC(2026, 3, 30));
  assert.deepEqual(credits(late), [60]);
  assert.equal(late.windows[0].isFinal, true);
  assert.equal(late.foldedCredits, 56);
});

test("activation inside a 28-day and a 29-day month keeps the total exact", () => {
  const feb2026 = [Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1)];
  const feb2028 = [Date.UTC(2028, 1, 1), Date.UTC(2028, 2, 1)];
  // The 20th is in week 3 (days 15 to 21): weeks 1 to 3 fold into it and the final week follows.
  assert.deepEqual(credits(activated(5, Date.UTC(2026, 1, 20), ...feb2026)), [3, 2], "Free: 1 + 1 + 1, then the final week's 2");
  assert.deepEqual(credits(activated(60, Date.UTC(2026, 1, 20), ...feb2026)), [45, 15], "28 days: three weeks folded, the fourth is the final window");
  assert.deepEqual(credits(activated(60, Date.UTC(2028, 1, 20), ...feb2028)), [42, 14, 4]);
  for (const [start, end] of [feb2026, feb2028]) {
    for (const plan of PLANS) {
      const total = activated(monthlyCreditsFor(plan), start + 9 * DAY + 3_600_000, start, end).windows.reduce((sum, window) => sum + window.credits, 0);
      assert.equal(total, monthlyCreditsFor(plan));
    }
  }
});

test("for every plan, month length and activation instant: exact total, contiguous windows, nothing before activation", () => {
  for (const plan of PLANS) {
    const monthly = monthlyCreditsFor(plan);
    for (const days of [28, 29, 30, 31]) {
      const full = schedule(monthly, days, APRIL);
      for (let hour = 0; hour < days * 24; hour += 5) {
        const at = APRIL + hour * 3_600_000 + (hour % 7) * 60_000;
        const s = allocationSchedule({ periodStart: APRIL, periodEnd: APRIL + days * DAY, monthlyCredits: monthly, activatedAt: at });
        const label = `${plan}/${days}d@${hour}h`;
        assert.equal(s.windows.reduce((sum, window) => sum + window.credits, 0), monthly, `${label}: total`);
        assert.equal(s.startMs, at, `${label}: the period starts at activation`);
        assert.equal(s.windows[0].startMs, at);
        assert.equal(s.windows.at(-1).endMs, APRIL + days * DAY);
        s.windows.forEach((window, i) => {
          assert.equal(window.index, i);
          assert.ok(window.endMs > window.startMs, `${label}: window ${i} is not empty`);
          if (i) assert.equal(window.startMs, s.windows[i - 1].endMs, `${label}: contiguous`);
          assert.equal(window.micros, window.credits * CREDIT_MICROS);
        });
        // Only the first window differs from the ordinary schedule, by exactly the elapsed weeks.
        const held = full.windows.findIndex((window) => at >= window.startMs && at < window.endMs);
        assert.equal(s.windows[0].credits, full.windows[held].cumulativeCredits, `${label}: folded first window`);
        assert.deepEqual(credits(s).slice(1), credits(full).slice(held + 1), `${label}: later windows unchanged`);
        assert.equal(windowIndexAt(s, at - 1), -1, `${label}: the instant before activation is outside the period`);
        assert.equal(windowIndexAt(s, at), 0, `${label}: activation itself is inside it`);
      }
    }
  }
});

test("balances after a mid-month activation: expiry spends the folded first window, carry the same cumulative amount", () => {
  const s = activated(60, Date.UTC(2026, 3, 10, 12));
  const now = Date.UTC(2026, 3, 12);
  const expiry = computeCreditBalance({ schedule: s, now, carryMode: "expiry", spentByWindowMicros: spendOf(10, 0, 0, 0) });
  assert.equal(expiry.availableMicros, MICROS(18), "28 in the first window, 10 spent");
  assert.equal(expiry.window.allocationCredits, 28);
  const carry = computeCreditBalance({ schedule: s, now, carryMode: "carry", spentByWindowMicros: spendOf(10, 0, 0, 0) });
  assert.equal(carry.availableMicros, MICROS(18), "the cumulative amount is the same, so carry and expiry agree on day one");
  // Next week they diverge exactly as they do in any month.
  const nextWeek = Date.UTC(2026, 3, 16);
  assert.equal(computeCreditBalance({ schedule: s, now: nextWeek, carryMode: "expiry", spentByWindowMicros: spendOf(10, 0, 0, 0) }).availableMicros, MICROS(14));
  assert.equal(computeCreditBalance({ schedule: s, now: nextWeek, carryMode: "carry", spentByWindowMicros: spendOf(10, 0, 0, 0) }).availableMicros, MICROS(32));
  assert.equal(computeCreditBalance({ schedule: s, now: nextWeek, carryMode: "carry", spentByWindowMicros: spendOf(10, 0, 0, 0) }).monthlyRemainingMicros, MICROS(50));
});

test("an activation time that is not usable is refused, not guessed", () => {
  assert.throws(() => activated(60, MAY), /before the period ends/);
  assert.throws(() => activated(60, MAY + DAY), /before the period ends/);
  assert.throws(() => activated(60, "not a time"), /valid time/);
});

// ---- Balances: the two policies -------------------------------------------------

const MICROS = (creditsAmount) => creditsAmount * CREDIT_MICROS;
const spendOf = (...perWindow) => perWindow.map((c) => MICROS(c));
const plus = () => schedule(60, 30);
const atWeek = (s, k, offsetMs = 1000) => s.windows[k].startMs + offsetMs;

test("expiry: only this week's allocation is spendable, and unused credits expire at the boundary", () => {
  const s = plus();
  const week0 = computeCreditBalance({ schedule: s, now: atWeek(s, 0), carryMode: "expiry", spentByWindowMicros: spendOf(4, 0, 0, 0, 0) });
  assert.equal(week0.availableMicros, MICROS(10), "14 allocated, 4 spent");
  const week1 = computeCreditBalance({ schedule: s, now: atWeek(s, 1), carryMode: "expiry", spentByWindowMicros: spendOf(4, 0, 0, 0, 0) });
  assert.equal(week1.availableMicros, MICROS(14), "week 1 starts at its own 14; week 0's unused 10 expired");
  assert.equal(week1.carriedInMicros, 0);
  // The expired credits cannot be spent later, and spending does not replenish the window.
  const spent14 = computeCreditBalance({ schedule: s, now: atWeek(s, 1), carryMode: "expiry", spentByWindowMicros: spendOf(0, 14, 0, 0, 0) });
  assert.equal(spent14.availableMicros, 0);
  assert.equal(spent14.exhausted, "week");
  const sameWindowAgain = computeCreditBalance({ schedule: s, now: atWeek(s, 1, 5 * DAY), carryMode: "expiry", spentByWindowMicros: spendOf(0, 14, 0, 0, 0) });
  assert.equal(sameWindowAgain.availableMicros, 0, "the same window is never replenished twice");
});

test("carry: unused credits stay spendable for the rest of the month, and future weeks are never early", () => {
  const s = plus();
  const week1 = computeCreditBalance({ schedule: s, now: atWeek(s, 1), carryMode: "carry", spentByWindowMicros: spendOf(4, 0, 0, 0, 0) });
  assert.equal(week1.availableMicros, MICROS(14 + 14 - 4), "two weeks allocated so far, 4 spent");
  assert.equal(week1.carriedInMicros, MICROS(10));
  assert.ok(week1.availableMicros < week1.monthlyRemainingMicros, "never the whole month early");
  assert.equal(week1.futureAllocationMicros, MICROS(60 - 28));
  const week0 = computeCreditBalance({ schedule: s, now: atWeek(s, 0), carryMode: "carry", spentByWindowMicros: spendOf(0, 0, 0, 0, 0) });
  assert.equal(week0.availableMicros, MICROS(14), "week 1's allocation is not available during week 0");
  const last = computeCreditBalance({ schedule: s, now: atWeek(s, 4), carryMode: "carry", spentByWindowMicros: spendOf(14, 14, 14, 0, 0) });
  assert.equal(last.availableMicros, MICROS(60 - 42), "in the final window everything unspent is available");
  assert.equal(last.nextAllocationAtMs, null);
  assert.equal(last.resetsAtMs, s.endMs);
});

test("monthly credits never carry into a new period under either policy", () => {
  const next = allocationSchedule({ periodStart: Date.UTC(2026, 4, 1), periodEnd: Date.UTC(2026, 5, 1), monthlyCredits: 60 });
  for (const carryMode of ["expiry", "carry"]) {
    const fresh = computeCreditBalance({ schedule: next, now: next.startMs + 1, carryMode, spentByWindowMicros: spendOf(0, 0, 0, 0, 0) });
    assert.equal(fresh.availableMicros, MICROS(next.windows[0].credits), `${carryMode}: a new month starts from its first allocation`);
    assert.equal(fresh.carriedInMicros, 0);
  }
});

test("overspend is absorbed the way each policy defines it", () => {
  const s = plus();
  const expiry = computeCreditBalance({ schedule: s, now: atWeek(s, 1), carryMode: "expiry", spentByWindowMicros: spendOf(20, 0, 0, 0, 0) });
  assert.equal(expiry.availableMicros, MICROS(14), "expiry: last week's overspend does not reduce the next week");
  const carry = computeCreditBalance({ schedule: s, now: atWeek(s, 1), carryMode: "carry", spentByWindowMicros: spendOf(20, 0, 0, 0, 0) });
  assert.equal(carry.availableMicros, MICROS(8), "carry: the month's spend is one account");
  const over = computeCreditBalance({ schedule: s, now: atWeek(s, 0), carryMode: "expiry", spentByWindowMicros: spendOf(15, 0, 0, 0, 0) });
  assert.equal(over.availableMicros, 0);
  assert.equal(over.headroomMicros, -MICROS(1), "the shortfall is kept so a zero-cost hold is still refused");
});

test("the month is a hard ceiling under expiry too: a large run-over in early weeks cannot be outspent later", () => {
  const s = plus();
  // 58 of 60 spent already (far past weeks 0 and 1's allocations): week 2 would grant 14 but only 2 remain.
  const bound = computeCreditBalance({ schedule: s, now: atWeek(s, 2), carryMode: "expiry", spentByWindowMicros: spendOf(30, 28, 0, 0, 0) });
  assert.equal(bound.availableMicros, MICROS(2), "the smaller of the week's allocation and what is left of the month");
  assert.equal(bound.exhausted, null);
  const gone = computeCreditBalance({ schedule: s, now: atWeek(s, 3), carryMode: "expiry", spentByWindowMicros: spendOf(30, 30, 0, 0, 0) });
  assert.equal(gone.availableMicros, 0);
  assert.equal(gone.exhausted, "month", "all 60 are spent, so this is a monthly exhaustion, not a weekly one");
  assert.equal(gone.monthlyRemainingMicros, 0);
  // Unused credits expiring is not spending them: ordinary under-use does not tighten the ceiling.
  const underUsed = computeCreditBalance({ schedule: s, now: atWeek(s, 3), carryMode: "expiry", spentByWindowMicros: spendOf(1, 1, 1, 0, 0) });
  assert.equal(underUsed.availableMicros, MICROS(14));
});

test("fractional credits are real: a balance under one credit is spendable and not exhausted", () => {
  const s = plus();
  const spent = MICROS(13) + 30_000; // 13.6 credits of 14
  const balance = computeCreditBalance({ schedule: s, now: atWeek(s, 0), carryMode: "expiry", spentByWindowMicros: [spent, 0, 0, 0, 0] });
  assert.equal(balance.availableMicros, 20_000);
  assert.equal(balance.exhausted, null, "0.4 credits is not exhausted");
  assert.equal(creditsPhrase(balance.availableMicros), "0.4 credits");
  const sliver = computeCreditBalance({ schedule: s, now: atWeek(s, 0), carryMode: "expiry", spentByWindowMicros: [MICROS(14) - 1, 0, 0, 0, 0] });
  assert.equal(sliver.availableMicros, 1);
  assert.equal(sliver.exhausted, null);
  assert.equal(creditsPhrase(1), "less than 0.01 credits");
});

test("exhaustion is named for what ran out: this week, or the whole month", () => {
  const s = plus();
  for (const carryMode of ["expiry", "carry"]) {
    const early = computeCreditBalance({ schedule: s, now: atWeek(s, 2), carryMode, spentByWindowMicros: spendOf(14, 14, 14, 0, 0) });
    assert.equal(early.exhausted, "week", `${carryMode}: out for now, more arrives`);
    assert.equal(early.nextAllocationAtMs, s.windows[2].endMs);
    const final = computeCreditBalance({ schedule: s, now: atWeek(s, 4), carryMode, spentByWindowMicros: spendOf(14, 14, 14, 14, 4) });
    assert.equal(final.exhausted, "month", `${carryMode}: nothing more this month`);
    assert.equal(final.nextAllocationAtMs, null);
  }
  const allSpent = computeCreditBalance({ schedule: s, now: atWeek(s, 1), carryMode: "carry", spentByWindowMicros: spendOf(30, 30, 0, 0, 0) });
  assert.equal(allSpent.exhausted, "month", "the whole month spent early is a monthly exhaustion, not a weekly one");
});

test("a carry mode is required and nothing defaults to one", () => {
  const s = plus();
  assert.throws(() => computeCreditBalance({ schedule: s, now: s.startMs, spentByWindowMicros: [] }), /carry mode/);
  assert.throws(() => computeCreditBalance({ schedule: s, now: s.startMs, carryMode: "yes", spentByWindowMicros: [] }), /carry mode/);
  assert.equal(normalizeCarryMode(" Expiry "), "expiry");
  assert.equal(normalizeCarryMode("CARRY"), CARRY_MODES.CARRY);
  for (const bad of ["", undefined, null, "weekly", "carry-forward", "true", "expire"]) assert.equal(normalizeCarryMode(bad), null, String(bad));
});

// ---- Display ---------------------------------------------------------------------

test("balances round down and spending rounds up, so a shown figure never overstates what is left", () => {
  assert.equal(formatCredits(33_333, "down"), "0.66");
  assert.equal(formatCredits(33_333, "up"), "0.67");
  assert.equal(formatCredits(MICROS(14), "down"), "14");
  assert.equal(formatCredits(MICROS(13) + 20_000, "down"), "13.4");
  assert.equal(formatCredits(0), "0");
  assert.equal(creditsPhrase(MICROS(1)), "1 credit");
  assert.equal(creditsPhrase(MICROS(2)), "2 credits");
  assert.equal(creditsPhrase(0), "0 credits");
  assert.equal(wholeCreditsPhrase(1), "1 credit");
  assert.equal(wholeCreditsPhrase(14), "14 credits");
});
