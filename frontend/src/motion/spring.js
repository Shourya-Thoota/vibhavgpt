// One small motion toolkit for everything a person can grab or throw: the
// phone drawer, the bottom sheet. (Menus, lists and the segmented indicator
// use CSS transitions, which already restart from the current value when
// interrupted.) Nothing here depends on React, so a gesture never waits on
// a render.
//
// The spring is described the way Apple describes it, with a damping ratio
// and a response, not mass, stiffness and damping:
//   dampingRatio: 1 settles without overshoot (the default for ordinary UI);
//                 below 1 overshoots, used only after a thrown gesture.
//   response:     roughly how quickly it gets there, in seconds. It is not a
//                 duration; the settle time follows from the parameters.
// For a unit mass: stiffness = (2π / response)², damping = 4π·ratio / response.
//
// Every spring is interruptible: `to()` retargets from the current value and
// the current velocity, so re-grabbing or reversing never jumps.

export const SPRINGS = Object.freeze({
  // Critically damped: menus, ordinary repositioning.
  standard: { dampingRatio: 1, response: 0.35 },
  // Sheets and drawers released with momentum: a little give, no wobble.
  thrown: { dampingRatio: 0.86, response: 0.32 },
});

// Advances a spring by dt seconds exactly, with its closed-form solution
// rather than numerical steps, so the path is the spring the parameters
// describe at any frame rate (stepping in small increments over-damped a
// sharp reversal by a few pixels, more at 60Hz than at 120Hz). Returns the
// new [offset from target, velocity].
export function stepSpring(offset, velocity, dt, dampingRatio, response) {
  const w = (2 * Math.PI) / response;
  if (dampingRatio >= 1) {
    // Critically damped (ratios above 1 are treated as 1: nothing here uses them).
    const b = velocity + w * offset;
    const decay = Math.exp(-w * dt);
    return [(offset + b * dt) * decay, (velocity - w * b * dt) * decay];
  }
  const wd = w * Math.sqrt(1 - dampingRatio * dampingRatio);
  const decay = Math.exp(-dampingRatio * w * dt);
  const cos = Math.cos(wd * dt);
  const sin = Math.sin(wd * dt);
  return [
    decay * (offset * cos + ((velocity + dampingRatio * w * offset) / wd) * sin),
    decay * (velocity * cos - ((w * w * offset + dampingRatio * w * velocity) / wd) * sin),
  ];
}

export function createSpring({ value = 0, velocity = 0, dampingRatio = 1, response = 0.35, onUpdate = () => {}, onRest = () => {}, now = () => performance.now(), frame = (fn) => requestAnimationFrame(fn), cancel = (id) => cancelAnimationFrame(id) } = {}) {
  let x = value;
  let v = velocity; // units per second
  let target = value;
  let ratio = dampingRatio;
  let resp = response;
  let handle = 0;
  let last = 0;
  // Bumped by stop() and set(), so a callback that stops the spring from
  // inside onUpdate is not undone by the frame this tick would schedule.
  let generation = 0;

  const tick = () => {
    const run = generation;
    const t = now();
    // Clamp the frame gap so a backgrounded tab does not leap on return.
    const dt = Math.min(0.064, Math.max(0, (t - last) / 1000));
    last = t;
    const [offset, speed] = stepSpring(x - target, v, dt, ratio, resp);
    x = target + offset;
    v = speed;
    if (Math.abs(x - target) < 0.4 && Math.abs(v) < 6) {
      x = target; v = 0; handle = 0;
      onUpdate(x);
      onRest(x);
      return;
    }
    onUpdate(x);
    if (run !== generation) return;
    handle = frame(tick);
  };

  return {
    // Retarget from wherever it is now. Options may change the spring and
    // hand in a new velocity (for a release, the finger's own velocity).
    to(next, options = {}) {
      target = next;
      if (options.velocity !== undefined) v = options.velocity;
      if (options.dampingRatio !== undefined) ratio = options.dampingRatio;
      if (options.response !== undefined) resp = options.response;
      if (!handle) { last = now(); handle = frame(tick); }
    },
    // Hold it where it is: a finger has taken over.
    stop() { if (handle) cancel(handle); handle = 0; v = 0; generation += 1; },
    // Move it without animating (while dragging).
    set(next) { if (handle) cancel(handle); handle = 0; x = next; target = next; v = 0; generation += 1; },
    get value() { return x; },
    get velocity() { return v; },
    get running() { return handle !== 0; },
  };
}

// Where a throw would come to rest if it decelerated like a scroll view.
// Apple's form, from Designing Fluid Interfaces; velocity in units per
// second, decelerationRate ~0.998 for normal scrolling feel.
export function project(velocity, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

// Progressive resistance past an edge: the further past, the less the
// element follows.
export function rubberband(overshoot, dimension, constant = 0.55) {
  if (!dimension) return 0;
  const sign = overshoot < 0 ? -1 : 1;
  const amount = Math.abs(overshoot);
  return sign * (amount * dimension * constant) / (dimension + constant * amount);
}

// Release velocity from the last few pointer samples (not the whole
// gesture), in units per second.
export function createVelocityTracker(windowMs = 90) {
  let samples = [];
  return {
    add(position, time) {
      samples.push({ position, time });
      const cutoff = time - windowMs;
      while (samples.length > 2 && samples[0].time < cutoff) samples.shift();
    },
    reset() { samples = []; },
    get velocity() {
      if (samples.length < 2) return 0;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (last.time - first.time) / 1000;
      return dt > 0 ? (last.position - first.position) / dt : 0;
    },
  };
}

export const prefersReducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
