import test from "node:test";
import assert from "node:assert/strict";
import { shouldOfferDirectUpdate } from "../frontend/src/direct-distribution.js";

test("direct APK update checks only offer newer native build codes", () => {
  assert.equal(shouldOfferDirectUpdate(1, 1), false);
  assert.equal(shouldOfferDirectUpdate(2, 1), false);
  assert.equal(shouldOfferDirectUpdate(1, 2), true);
  assert.equal(shouldOfferDirectUpdate(undefined, 1), false);
  assert.equal(shouldOfferDirectUpdate(1, undefined), false);
  assert.equal(shouldOfferDirectUpdate("1", "2"), true);
});
