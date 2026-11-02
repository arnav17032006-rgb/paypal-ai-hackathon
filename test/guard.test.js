import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as store from "../server/store.js";
import * as guard from "../server/guard.js";

beforeEach(() => store.reset());

test("trusted merchant under the auto-approve threshold is allowed", () => {
  const r = guard.evaluate({ productId: "p_choc_cake", quantity: 1, deadlineDays: 1 });
  assert.equal(r.decision, "allow");
});

test("scam merchant is blocked no matter how cheap", () => {
  const r = guard.evaluate({ productId: "p_airpods_fake", quantity: 1 });
  assert.equal(r.decision, "block");
  assert.ok(r.checks.some((c) => c.rule === "merchant_trust" && c.severity === "block"));
  assert.ok(r.checks.some((c) => c.rule === "scam_signals" && c.severity === "block"));
});

test("purchase above the ask threshold needs the user's OK", () => {
  const r = guard.evaluate({ productId: "p_ds_book", quantity: 1 });
  assert.equal(r.decision, "ask");
});

test("per-order limit blocks large quantities", () => {
  const r = guard.evaluate({ productId: "p_choc_cake", quantity: 3 });
  assert.equal(r.decision, "block");
  assert.ok(r.checks.some((c) => c.rule === "per_order_limit" && c.severity === "block"));
});

test("missed delivery deadline escalates to ask", () => {
  const r = guard.evaluate({ productId: "p_atomic", quantity: 1, deadlineDays: 1 });
  assert.equal(r.decision, "ask");
});

test("new merchant with red flags scores low", () => {
  const t = guard.scoreNewMerchant({ refundPolicy: "", deliveryPolicy: "", paypalEmail: "", aiRedFlags: ["asks for friends-and-family payments"] });
  assert.equal(t.level, "low");
});
