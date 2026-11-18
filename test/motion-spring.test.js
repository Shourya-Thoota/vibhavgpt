import test from "node:test";
import assert from "node:assert/strict";
import { createSpring, project, rubberband, stepSpring, SPRINGS } from "../frontend/src/motion/spring.js";

// The motion toolkit behind the drawer, the bottom sheet and the sidebar.
// A fake clock and frame loop drive it, so these are exact, not timed.
function driver(options) {
  let clock = 0; let queued = null; let painted = options.value ?? 0; let rested = false;
  const spring = createSpring({ ...options, now: () => clock, frame: (fn) => { queued = fn; return 1; }, cancel: () => { queued = null; }, onUpdate: (x) => { painted = x; options.onUpdate?.(x, spring); }, onRest: () => { rested = true; } });
  return {
    spring,
    frame(ms) { clock += ms; const fn = queued; queued = null; fn?.(); return painted; },
    get painted() { return painted; },
    get rested() { return rested; },
    get pending() { return queued !== null; },
  };
}

// x after t seconds, from rest at `from`, for a critically damped spring.
const critical = (from, to, t, response) => { const w = (2 * Math.PI) / response; return to + (from - to) * (1 + w * t) * Math.exp(-w * t); };

test("the path is the spring's own, at any frame rate", () => {
  for (const ms of [1, 1000 / 120, 1000 / 60, 1000 / 30]) {
    const d = driver({ value: 268 });
    d.spring.to(74, SPRINGS.standard);
    let t = 0;
    for (let i = 0; i < 12; i += 1) {
      const x = d.frame(ms); t += ms / 1000;
      assert.ok(Math.abs(x - critical(268, 74, t, SPRINGS.standard.response)) < 1e-6, `${ms.toFixed(1)}ms frames, t=${t.toFixed(3)}: ${x} vs the closed form`);
    }
  }
});

test("a reversal mid-motion keeps position and velocity, and coasts exactly as the closed form says", () => {
  const paths = [1, 1000 / 60].map((ms) => {
    const d = driver({ value: 268 });
    d.spring.to(74, SPRINGS.standard);
    for (let t = 0; t < 83; t += ms) d.frame(ms);
    const at = d.spring.value; const v0 = d.spring.velocity;
    d.spring.to(268);
    assert.equal(d.spring.value, at, "retargeting does not move it");
    assert.equal(d.spring.velocity, v0, "or change its velocity");
    return { at, v0, x: d.frame(1000 / 60) };
  });
  // Same state, same 16.7ms later: the same place whichever frame rate led there.
  const w = (2 * Math.PI) / SPRINGS.standard.response;
  for (const { at, v0, x } of paths) {
    const e0 = at - 268; const t = 1 / 60;
    assert.ok(Math.abs(x - (268 + (e0 + (v0 + w * e0) * t) * Math.exp(-w * t))) < 1e-6);
  }
});

test("the thrown spring overshoots a little and settles, matching its closed form", () => {
  const { dampingRatio, response } = SPRINGS.thrown;
  const w = (2 * Math.PI) / response; const wd = w * Math.sqrt(1 - dampingRatio ** 2);
  const d = driver({ value: 0 });
  d.spring.to(100, { velocity: 0, ...SPRINGS.thrown });
  let t = 0; let peak = 0;
  while (d.pending && t < 3) {
    const x = d.frame(1000 / 60); t += 1 / 60;
    if (!d.rested) {
      const e = -100 * Math.exp(-dampingRatio * w * t) * (Math.cos(wd * t) + ((dampingRatio * w) / wd) * Math.sin(wd * t));
      assert.ok(Math.abs(x - (100 + e)) < 1e-6, `t=${t.toFixed(3)}`);
    }
    peak = Math.max(peak, x);
  }
  assert.ok(peak > 100 && peak < 101.5, `a little give (peak ${peak.toFixed(2)})`);
  assert.ok(d.rested && d.painted === 100, "and it comes to rest on the target");
});

test("a long frame advances at most 64ms, so a backgrounded tab does not leap", () => {
  const a = driver({ value: 0 }); a.spring.to(100);
  const b = driver({ value: 0 }); b.spring.to(100);
  assert.equal(a.frame(5000), b.frame(64));
});

test("stopping from inside onUpdate sticks: no further frame is scheduled", () => {
  let updates = 0;
  const d = driver({ value: 0, onUpdate: (x, spring) => { updates += 1; if (x > 40) spring.stop(); } });
  d.spring.to(100);
  for (let i = 0; i < 40 && d.pending; i += 1) d.frame(1000 / 60);
  assert.equal(d.pending, false);
  assert.ok(d.painted > 40 && d.painted < 100);
  const seen = updates;
  d.frame(1000 / 60);
  assert.equal(updates, seen, "nothing runs after the stop");
});

test("stepSpring at dt 0 changes nothing, and momentum and edges follow Apple's formulas", () => {
  assert.deepEqual(stepSpring(-50, 300, 0, 1, 0.35), [-50, 300]);
  assert.deepEqual(stepSpring(-50, 300, 0, 0.86, 0.32), [-50, 300]);
  // projectedEndpoint = (v / 1000) * d / (1 - d), d = 0.998
  assert.ok(Math.abs(project(1000) - 499) < 1e-9);
  assert.equal(project(0), 0);
  // Rubberband: resists progressively, never reaches the dimension, keeps sign.
  assert.ok(rubberband(100, 300) < 100 && rubberband(100, 300) > 0);
  assert.ok(rubberband(10000, 300) < 300);
  assert.equal(rubberband(-100, 300), -rubberband(100, 300));
});
