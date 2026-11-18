import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:9/unused";
process.env.BETTER_AUTH_SECRET ||= "test-only-auth-secret-not-used-for-anything-real";

const root = path.resolve(import.meta.dirname, "..");

// Images cannot be bought: at the limit the request is refused until the allowance renews, and no credit pays for one. So no screen,
// page, FAQ, notice or error may say otherwise. A line that says it in the negative ("can't be bought", "do not add images") is fine.
const PROMISES = [
  /\b3 (flex |image & document )?credits?\b/i, // the retired "3 credits per extra image"
  /\b(buy|purchase|top up|add)( more| extra| additional)? images\b/i,
  /\bextra images\b/i,
  /\bimages? (beyond|past|over)\b[^.]{0,40}\b(cost|use|credit)/i,
  /\bcredits?\b (can|will|to) (buy|add|unlock|pay for)\b[^.]{0,25}\bimages?\b/i,
];
const NEGATED = /\b(can't|cannot|can not|don't|do not|doesn't|does not|never|not|no)\b/i;

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "test", "tests", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (/\.(js|jsx|ts|tsx|html)$/.test(entry.name)) yield full;
  }
}

test("no customer-facing copy promises that images can be bought or paid for with credits", () => {
  const offenders = [];
  for (const dir of ["frontend/src", "frontend/public", "src"]) {
    for (const file of sources(path.join(root, dir))) {
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const text = line.replace(/^\s*(\/\/|\*|\/\*).*$/, ""); // code comments are not customer copy
        if (!text.trim()) return;
        if (PROMISES.some((pattern) => pattern.test(text)) && !NEGATED.test(text)) offenders.push(`${path.relative(root, file)}:${index + 1}: ${text.trim().slice(0, 140)}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});

test("the scan itself catches a promise and lets a denial through", () => {
  const flagged = (line) => PROMISES.some((pattern) => pattern.test(line)) && !NEGATED.test(line);
  assert.equal(flagged("Extra images beyond your plan cost 3 credits each."), true);
  assert.equal(flagged("Buy more images with credits."), true);
  assert.equal(flagged("Image & document credits can't buy extra images."), false);
  assert.equal(flagged("Extra images can't be bought."), false);
});
