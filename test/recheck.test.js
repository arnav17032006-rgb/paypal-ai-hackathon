// Limits and trust change while an order waits, so the guard has to decide again before money is committed.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { app } from "../server/app.js";
import * as store from "../server/store.js";
import * as guard from "../server/guard.js";
import * as orders from "../server/orders.js";
import * as paypal from "../server/paypal.js";
import * as webhooks from "../server/webhooks.js";

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => store.reset());

let buyerCookie;
const confirm = async (o) => {
  if (!buyerCookie) {
    const login = await fetch(`${base}/api/auth/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "buyer" }) });
    buyerCookie = login.headers.get("set-cookie").split(";")[0];
  }
  const r = await fetch(`${base}/api/orders/${o.id}/confirm`, { method: "POST", headers: { Cookie: buyerCookie } });
  return { status: r.status, body: await r.json() };
};
const place = async (productId) => (await orders.placeOrder({ productId, quantity: 1, channel: "MCP agent" })).order;
const placeMany = async (productId, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await place(productId));
  return out;
};
const productOf = (id) => store.product(id).product;
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test("approving waiting orders can't exceed the daily limit", async () => {
  productOf("p_ds_book").stock = 10;
  const asks = await placeMany("p_ds_book", 4); // $42 each, above the $35 auto-approve threshold
  assert.ok(asks.every((o) => o.status === "NEEDS_USER_OK"));

  for (const o of asks.slice(0, 3)) assert.equal((await confirm(o)).status, 200);
  const fourth = await confirm(asks[3]);
  assert.equal(fourth.status, 409);
  assert.match(fourth.body.error, /daily limit/);
  assert.equal(store.order(asks[3].id).status, "NEEDS_USER_OK");
  assert.equal(store.spentToday(), 126);
});

test("approving waiting orders can't sell more than is in stock", async () => {
  store.data().mandate.dailyLimit = 1000;
  const asks = await placeMany("p_ds_book", 4); // only 3 in stock
  for (const o of asks.slice(0, 3)) assert.equal((await confirm(o)).status, 200);
  const fourth = await confirm(asks[3]);
  assert.equal(fourth.status, 409);
  assert.match(fourth.body.error, /stock/);
  assert.doesNotMatch(fourth.body.error, /daily limit/);
});

test("an approval is refused once trust has fallen, and works again if the owner changes the rules", async () => {
  const o = await place("p_ds_book");
  guard.penalize(store.merchant(o.merchantId), 60, "disputes while waiting");

  const refused = await confirm(o);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /merchant trust/);
  assert.equal(store.order(o.id).status, "NEEDS_USER_OK");
  assert.equal(store.spentToday(), 0);

  store.data().mandate.minMerchantTrust = 0;
  assert.equal((await confirm(o)).body.status, "AWAITING_APPROVAL");
});

test("no funds are held if the guard blocks after the buyer approved on PayPal", async () => {
  const o = await place("p_choc_cake");
  const stock = productOf("p_choc_cake").stock;
  guard.penalize(store.merchant(o.merchantId), 60, "disputes while the link was open");
  paypal.simulateApproval(o.paypalOrderId);

  const r = await fetch(`${base}/paypal/return?token=${o.paypalOrderId}`, { redirect: "manual" });
  assert.match(r.headers.get("location"), /blocked=/);
  assert.equal(o.status, "BLOCKED");
  assert.equal(o.authorizationId, undefined);
  assert.equal(productOf("p_choc_cake").stock, stock);
  assert.equal(store.spentToday(), 0);
});

test("the webhook path is re-checked too", async () => {
  const o = await place("p_choc_cake");
  guard.penalize(store.merchant(o.merchantId), 60, "disputes while the link was open");
  const r = await webhooks.simulate(o, "approved");
  assert.equal(r.status, "BLOCKED");
  assert.equal(o.authorizationId, undefined);
  assert.ok(store.data().events.some((e) => e.type === "webhook" && e.message.includes("no hold was placed")));
});

test("a normal approval still places the hold and takes the stock", async () => {
  const o = await place("p_choc_cake");
  const stock = productOf("p_choc_cake").stock;
  paypal.simulateApproval(o.paypalOrderId);
  const r = await fetch(`${base}/paypal/return?token=${o.paypalOrderId}`, { redirect: "manual" });
  assert.match(r.headers.get("location"), /paid=/);
  assert.equal(o.status, "AUTHORIZED");
  assert.ok(o.authorizationId);
  assert.equal(productOf("p_choc_cake").stock, stock - 1);
  assert.equal(store.spentToday(), 24);
});

test("parallel checkouts can't race past the daily limit", async () => {
  productOf("p_choc_cake").stock = 100;
  const results = await Promise.all(Array.from({ length: 7 }, () => orders.placeOrder({ productId: "p_choc_cake", channel: "MCP agent" })));
  assert.equal(results.filter((r) => r.order).length, 6); // 6 x $24 = $144; a 7th would be $168 against $150
  assert.equal(store.spentToday(), 144);
});

test("parallel approvals can't race past the daily limit", async () => {
  productOf("p_ds_book").stock = 10;
  const asks = await placeMany("p_ds_book", 4);
  const results = await Promise.allSettled(asks.map((o) => orders.confirm(o)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(store.spentToday(), 126);
});

test("a failed PayPal call releases the claim on the budget", async () => {
  // A non-string merchant name makes order creation throw, standing in for a PayPal outage.
  const bakery = store.merchant("m_crumbs");
  const realName = bakery.name;
  bakery.name = 123;
  await assert.rejects(orders.placeOrder({ productId: "p_choc_cake", channel: "MCP agent" }));
  assert.equal(store.data().orders[0].status, "FAILED");
  assert.equal(store.spentToday(), 0);
  bakery.name = realName;

  const o = await place("p_ds_book");
  const books = store.merchant(o.merchantId);
  const realBooks = books.name;
  books.name = 123;
  await assert.rejects(orders.confirm(o));
  assert.equal(o.status, "NEEDS_USER_OK");
  assert.equal(store.spentToday(), 0);
  books.name = realBooks;
  assert.equal((await orders.confirm(o)).status, "AWAITING_APPROVAL");
});

test("a waiting order counts against the day it is approved, not the day it was asked", async () => {
  const o = await place("p_ds_book");
  o.createdAt = hoursAgo(72);
  await orders.confirm(o);
  assert.equal(store.spentToday(), 42);
});

test("old PayPal links can't stack up past today's limit", async () => {
  const [a, b] = [await place("p_choc_cake"), await place("p_redvelvet")];
  assert.equal(a.status, "AWAITING_APPROVAL");
  assert.equal(b.status, "AWAITING_APPROVAL");
  store.data().mandate.dailyLimit = 30;
  for (const o of [a, b]) {
    o.createdAt = hoursAgo(72);
    o.committedAt = hoursAgo(72);
    paypal.simulateApproval(o.paypalOrderId);
  }
  assert.equal(store.spentToday(), 0);

  await orders.authorize(a, "test");
  assert.equal(a.status, "AUTHORIZED");
  assert.equal(store.spentToday(), 24);

  await orders.authorize(b, "test"); // $24 + $15 against $30
  assert.equal(b.status, "BLOCKED");
  assert.equal(store.spentToday(), 24);
});

test("an abandoned link stops reserving stock after a day, and approving it late can't oversell", async () => {
  productOf("p_redvelvet").stock = 1;
  const stale = await place("p_redvelvet");
  assert.equal(await place("p_redvelvet"), null, "the last unit is reserved");

  stale.committedAt = hoursAgo(25);
  const fresh = await place("p_redvelvet");
  assert.equal(fresh.status, "AWAITING_APPROVAL");

  paypal.simulateApproval(stale.paypalOrderId);
  await orders.authorize(stale, "test");
  assert.equal(stale.status, "BLOCKED");

  paypal.simulateApproval(fresh.paypalOrderId);
  await orders.authorize(fresh, "test");
  assert.equal(fresh.status, "AUTHORIZED");
  assert.equal(productOf("p_redvelvet").stock, 0);
});

test("a webhook that fails is applied when PayPal retries it", async () => {
  const o = await place("p_choc_cake");
  const event = { id: "WH-RETRY", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: o.paypalOrderId } };
  await assert.rejects(webhooks.handleEvent(event)); // the simulator refuses: the buyer hasn't approved yet
  paypal.simulateApproval(o.paypalOrderId);
  const retry = await webhooks.handleEvent(event);
  assert.equal(retry.duplicate, undefined);
  assert.equal(retry.status, "AUTHORIZED");
});
