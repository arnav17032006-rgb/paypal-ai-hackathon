// Accounts: sign-up, login, sessions, and each person seeing and acting on only their own side.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../server/app.js";
import * as store from "../server/store.js";

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => store.reset());

const email = () => `t-${crypto.randomBytes(4).toString("hex")}@example.com`;

async function call(method, path, body, cookie) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json, cookie: r.headers.get("set-cookie")?.split(";")[0], location: r.headers.get("location") };
}

async function signup(role, extra = {}) {
  const creds = { name: role === "buyer" ? "Asha" : "Ravi", email: email(), password: "correct horse 1", role, ...extra };
  const r = await call("POST", "/api/auth/signup", creds);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...creds, cookie: r.cookie, user: r.body };
}

test("the app needs a login, and the login page sends logged-in people to the app", async () => {
  assert.equal((await call("GET", "/")).location, "/login.html");
  assert.equal((await call("GET", "/api/state")).status, 401);
  assert.equal((await call("GET", "/api/health")).body.ok, true, "the health check needs no login");
  const { cookie } = await signup("buyer");
  assert.equal((await call("GET", "/", null, cookie)).status, 200);
  assert.equal((await call("GET", "/login.html", null, cookie)).location, "/");
});

test("sign-up stores a salted hash, never the password, and checks its input", async () => {
  const b = await signup("buyer");
  assert.equal(b.user.role, "buyer");
  assert.equal(b.user.passwordHash, undefined);
  const stored = store.userByEmail(b.email);
  assert.match(stored.passwordHash, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.ok(!JSON.stringify(store.data()).includes(b.password));

  assert.equal((await call("POST", "/api/auth/signup", { ...b, cookie: undefined })).status, 409);
  assert.equal((await call("POST", "/api/auth/signup", { name: "x", email: email(), password: "short", role: "buyer" })).status, 400);
  assert.equal((await call("POST", "/api/auth/signup", { name: "x", email: "not-an-email", password: "long enough 1", role: "buyer" })).status, 400);
  assert.equal((await call("POST", "/api/auth/signup", { name: "x", email: email(), password: "long enough 1", role: "admin" })).status, 400);
});

test("login checks the password and the role you chose, and logout ends the session", async () => {
  const b = await signup("buyer");
  assert.equal((await call("POST", "/api/auth/login", { email: b.email, password: "wrong password", role: "buyer" })).status, 401);
  const wrongRole = await call("POST", "/api/auth/login", { email: b.email, password: b.password, role: "merchant" });
  assert.equal(wrongRole.status, 403);
  assert.match(wrongRole.body.error, /buyer account/);

  const ok = await call("POST", "/api/auth/login", { email: b.email.toUpperCase(), password: b.password, role: "buyer" });
  assert.equal(ok.status, 200);
  assert.equal((await call("GET", "/api/auth/me", null, ok.cookie)).body.email, b.email);

  await call("POST", "/api/auth/logout", null, ok.cookie);
  assert.equal((await call("GET", "/api/state", null, ok.cookie)).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { email: "owner@demo.agentready", password: "" })).status, 401, "demo accounts have no password login");
});

test("a buyer can't use shop-owner actions, and a shop owner can't shop", async () => {
  const b = await signup("buyer");
  const m = await signup("merchant");
  assert.equal((await call("POST", "/api/merchants/preview", { text: "Shop\nThing - $5" }, b.cookie)).status, 403);
  assert.equal((await call("POST", "/api/assistant", { question: "money?" }, b.cookie)).status, 403);
  assert.equal((await call("POST", "/api/agent/run", { goal: "cake" }, m.cookie)).status, 403);
  assert.equal((await call("PUT", "/api/mandate", { perOrderLimit: 1 }, m.cookie)).status, 403);
  assert.equal((await call("POST", "/api/reset", null, b.cookie)).status, 403, "only demo accounts can reset shared data");
});

test("each buyer has their own orders, spending and rules", async () => {
  const a = await signup("buyer");
  const b = await signup("buyer");
  const run = await call("POST", "/api/agent/run", { goal: "Chocolate birthday cake under $30, needed tomorrow" }, a.cookie);
  const order = run.body.order;
  assert.equal(store.order(order.id).buyerId, a.user.id);

  const aState = (await call("GET", "/api/state", null, a.cookie)).body;
  const bState = (await call("GET", "/api/state", null, b.cookie)).body;
  assert.deepEqual(aState.orders.map((o) => o.id), [order.id]);
  assert.equal(aState.spentToday, 24);
  assert.equal(bState.orders.length, 0);
  assert.equal(bState.spentToday, 0);
  assert.equal(bState.events.length, 0, "B sees none of A's agent activity");

  // B can't act on A's order, even knowing its id.
  assert.equal((await call("POST", `/api/orders/${order.id}/decline`, null, b.cookie)).status, 404);

  await call("PUT", "/api/mandate", { perOrderLimit: 5 }, a.cookie);
  assert.equal(store.mandateFor(a.user.id).perOrderLimit, 5);
  assert.equal(store.mandateFor(b.user.id).perOrderLimit, 60);
  assert.equal(store.data().mandate.perOrderLimit, 60, "the demo buyer's rules are untouched");
  const blocked = await call("POST", "/api/agent/run", { goal: "Chocolate birthday cake under $30, needed tomorrow" }, a.cookie);
  assert.equal(blocked.body.order, null, "A's own lower limit now blocks the cake");
});

test("a shop owner sees and runs only their own shops and orders", async () => {
  const m = await signup("merchant");
  const preview = await call("POST", "/api/merchants/preview", { text: "Clean Candles\nLavender candle - $9\nReturns within 7 days if broken." }, m.cookie);
  const shop = (await call("POST", "/api/merchants", { draftId: preview.body.draftId, paypalEmail: "seller@example.com" }, m.cookie)).body;
  assert.equal(shop.ownerId, m.user.id);

  const mine = (await call("GET", "/api/state", null, m.cookie)).body;
  assert.deepEqual(mine.merchants.map((x) => x.id), [shop.id]);
  assert.equal(mine.orders.length, 0);

  // Another owner can't publish this owner's draft, and can't capture orders from shops they don't own.
  const other = await signup("merchant");
  const preview2 = await call("POST", "/api/merchants/preview", { text: "Other Shop\nMug - $7\nRefunds within 7 days." }, m.cookie);
  assert.equal((await call("POST", "/api/merchants", { draftId: preview2.body.draftId }, other.cookie)).status, 400);

  const b = await signup("buyer");
  const run = await call("POST", "/api/agent/run", { goal: "Chocolate birthday cake under $30, needed tomorrow" }, b.cookie);
  assert.equal((await call("POST", `/api/orders/${run.body.order.id}/fulfil`, null, m.cookie)).status, 404, "the cake is from a demo shop, not theirs");

  const owner = await call("POST", "/api/auth/demo", { role: "merchant" });
  const demoView = (await call("GET", "/api/state", null, owner.cookie)).body;
  assert.ok(demoView.orders.some((o) => o.id === run.body.order.id), "the demo shop owner sees orders for the demo shops");
  assert.ok(!demoView.merchants.some((x) => x.id === shop.id));
});

test("an outside agent with a buyer's key shops under that buyer's account", async () => {
  const b = await signup("buyer");
  assert.match(b.user.agentKey, /^[0-9a-f]{48}$/);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${b.user.agentKey}` } } }));
  const r = JSON.parse((await client.callTool({ name: "checkout", arguments: { product_id: "p_choc_cake", quantity: 1, reason: "cake" } })).content[0].text);
  await client.close();
  assert.equal(store.order(r.order_id).buyerId, b.user.id);
  assert.equal(store.spentToday(undefined, b.user.id), 24);
  assert.equal(store.spentToday(), 0, "nothing was charged to the demo buyer");

  const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer nope" }, body: "{}" });
  assert.equal(bad.status, 401);
});

test("a buyer's state says what their rules allow, product by product, and follows rule changes", async () => {
  const buyer = await signup("buyer");
  const before = (await call("GET", "/api/state", null, buyer.cookie)).body.coverage;
  const of = (rows, id) => rows.find((r) => r.productId === id);
  assert.equal(of(before, "p_choc_cake").decision, "allow");
  assert.equal(of(before, "p_ds_book").decision, "ask"); // $42 is above the $35 ask-me threshold
  const fake = of(before, "p_airpods_fake");
  assert.equal(fake.decision, "block");
  assert.ok(fake.reasons.some((r) => r.rule === "merchant_trust"));
  await call("PUT", "/api/mandate", { perOrderLimit: 10 }, buyer.cookie);
  const after = (await call("GET", "/api/state", null, buyer.cookie)).body.coverage;
  assert.equal(of(after, "p_choc_cake").decision, "block");
  // Shop owners get no buyer coverage.
  const owner = await signup("merchant");
  assert.equal((await call("GET", "/api/state", null, owner.cookie)).body.coverage, undefined);
});
