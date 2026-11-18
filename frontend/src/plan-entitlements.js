// The image allowances each plan is sold with: one place for every screen, page and product explanation that states them.
//
// The server enforces the same numbers (src/generation/image-engine.js, src/models/pricing-engine.js and, for what Usage shows,
// src/usage/service.js). The frontend is built on its own and cannot import those, so test/max-image-agreement.test.js compares
// every one of them with this and fails if any disagrees. Change a number here and in the three enforcement files together.
//
// Max is 1,500 images a month (the owner's decision, merged in PR #74).
export const IMAGES_PER_MONTH = Object.freeze({ plus: 100, pro: 400, max: 1500 });
export const IMAGES_PER_WEEK = Object.freeze({ free: 2 });

/** 1500 -> "1,500": a count as a person reads it. */
export const countText = (value) => Number(value).toLocaleString("en-US");
