/* global agGrid */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const badge = (v) => `<span class="badge ${esc(v)}">${esc(String(v).replace(/_/g, " "))}</span>`;
let state = null;
let pendingCatalog = null;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 3500);
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `Request failed (${r.status})`);
  return json;
}

// ---------------------------------------------------------------- tabs
function showTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  Object.values(grids).forEach((g) => g?.api && setTimeout(() => g.api.sizeColumnsToFit?.(), 0));
}
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------------------------------------------------------------- grids
class ActionsRenderer {
  init(p) { this.el = orderActions(p.data); }
  getGui() { return this.el; }
  refresh() { return false; }
}

const grids = {};
function grid(id, columnDefs) {
  grids[id] = { api: agGrid.createGrid($(`#${id}`), {
    columnDefs,
    rowData: [],
    defaultColDef: { sortable: true, filter: true, resizable: true, minWidth: 90 },
    animateRows: true,
    pagination: true,
    paginationPageSize: 20,
    paginationPageSizeSelector: false,
  }) };
}

grid("grid-orders", [
  { field: "createdAt", headerName: "When", valueFormatter: (p) => new Date(p.value).toLocaleString(), sort: "desc", minWidth: 160 },
  { field: "productName", headerName: "Item", flex: 2, minWidth: 180 },
  { field: "merchantName", headerName: "Merchant", flex: 1 },
  { field: "amount", headerName: "Amount", valueFormatter: (p) => money(p.value), filter: "agNumberColumnFilter", width: 110 },
  { field: "guardDecision", headerName: "Guard", cellRenderer: (p) => badge(p.value), width: 120 },
  { field: "status", cellRenderer: (p) => badge(p.value), minWidth: 150 },
  { field: "paypalOrderId", headerName: "PayPal order", minWidth: 160 },
  { headerName: "Actions", colId: "actions", valueGetter: (p) => p.data.status, pinned: "right", sortable: false, filter: false, minWidth: 250, cellRenderer: ActionsRenderer },
]);

grid("grid-events", [
  { field: "at", headerName: "Time", valueFormatter: (p) => new Date(p.value).toLocaleTimeString(), width: 120, sort: "desc" },
  { field: "type", cellRenderer: (p) => badge(p.value), width: 120 },
  { field: "message", flex: 1, minWidth: 300, wrapText: true, autoHeight: true },
]);

grid("grid-merchants", [
  { field: "name", flex: 2, minWidth: 180 },
  { field: "trust.score", headerName: "Trust", filter: "agNumberColumnFilter", width: 100 },
  { field: "trust.level", headerName: "Level", cellRenderer: (p) => badge(p.value), width: 110 },
  { headerName: "Products", valueGetter: (p) => p.data.products.length, width: 110 },
  { field: "completedOrders", headerName: "Orders", width: 100 },
  { field: "disputes", width: 100 },
  { field: "refundPolicy", headerName: "Refund policy", flex: 2, minWidth: 200, valueFormatter: (p) => p.value || "None" },
  { headerName: "Why this score", flex: 3, minWidth: 260, valueGetter: (p) => p.data.trust.reasons.join("; "), wrapText: true, autoHeight: true },
]);

function orderActions(o) {
  const el = document.createElement("span");
  const btn = (label, fn, cls = "") => {
    const b = document.createElement("button");
    b.className = `cell-btn ${cls}`;
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); await refresh(); } catch (e) { toast(e.message); b.disabled = false; }
    };
    el.append(b);
  };
  if (o.status === "NEEDS_USER_OK") {
    btn("Approve", async () => { const r = await api("POST", `/api/orders/${o.id}/confirm`); location.href = r.approveUrl; }, "primary");
    btn("Decline", () => api("POST", `/api/orders/${o.id}/decline`));
  }
  if (o.status === "AWAITING_APPROVAL" && o.approveUrl) btn("Pay with PayPal", async () => { location.href = o.approveUrl; }, "primary");
  if (o.status === "AUTHORIZED") {
    btn("Mark delivered", () => api("POST", `/api/orders/${o.id}/fulfil`).then(() => toast("Captured: money sent to the merchant")), "primary");
    btn("Release hold", () => api("POST", `/api/orders/${o.id}/void`));
  }
  if (o.status === "CAPTURED") btn("Refund", () => api("POST", `/api/orders/${o.id}/refund`).then(() => toast("Refunded through PayPal")));
  return el;
}

// ---------------------------------------------------------------- render
function renderModes() {
  const { ai, paypal } = state.modes;
  $("#modes").innerHTML =
    `<span class="pill ${ai === "claude" ? "live" : ""}" title="Set ANTHROPIC_API_KEY to use Claude">AI: ${ai === "claude" ? "Claude" : "rule-based fallback"}</span>` +
    `<span class="pill ${paypal === "sandbox" ? "live" : ""}" title="Set PAYPAL_CLIENT_ID/SECRET to use the PayPal sandbox">PayPal: ${paypal}</span>`;
}

function renderKpis() {
  const o = state.orders;
  const captured = o.filter((x) => x.status === "CAPTURED");
  const held = o.filter((x) => x.status === "AUTHORIZED");
  const blocked = state.events.filter((e) => e.type === "guard" && e.message.startsWith("Blocked")).length;
  const k = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
  $("#kpis").innerHTML =
    k(money(captured.reduce((s, x) => s + x.amount, 0)), "Paid to merchants") +
    k(money(held.reduce((s, x) => s + x.amount, 0)), "Held, awaiting delivery") +
    k(`${money(state.spentToday)} / ${money(state.mandate.dailyLimit)}`, "Agent spend today") +
    k(blocked, "Risky payments blocked") +
    k(state.merchants.length, "Agent-ready merchants");
}

function renderMandate() {
  const m = state.mandate;
  const all = ["food", "gifts", "books", "stationery", "electronics", "home", "fashion", "beauty", "services", "other"];
  const num = (k, label) => `<div><label>${label}</label><input type="number" min="0" step="1" name="${k}" value="${m[k]}"></div>`;
  $("#mandate-form").innerHTML =
    num("perOrderLimit", "Max per order (USD)") + num("dailyLimit", "Max per day (USD)") +
    num("askAbove", "Ask me above (USD)") + num("minMerchantTrust", "Minimum merchant trust (0-100)") +
    `<div class="full"><label>Allowed categories</label><div class="cats">${all.map((c) => `<label><input type="checkbox" name="cat" value="${c}" ${m.allowedCategories.includes(c) ? "checked" : ""}>${c}</label>`).join("")}</div></div>` +
    `<div class="full"><label class="chk"><input type="checkbox" name="requireRefundPolicy" ${m.requireRefundPolicy ? "checked" : ""}> Only buy from merchants with a refund policy</label></div>` +
    `<div class="full"><button class="primary" type="submit">Save mandate</button></div>`;
}

async function refresh() {
  state = await api("GET", "/api/state");
  renderModes();
  renderKpis();
  grids["grid-orders"].api.setGridOption("rowData", state.orders);
  grids["grid-events"].api.setGridOption("rowData", state.events);
  grids["grid-merchants"].api.setGridOption("rowData", state.merchants);
  if (!document.activeElement?.closest("#mandate-form")) renderMandate();
}

// ---------------------------------------------------------------- shopper agent
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { $("#goal").value = c.textContent; }));

$("#goal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = $("#goal").value.trim();
  if (!goal) return;
  const btn = $("#goal-btn");
  btn.disabled = true;
  btn.textContent = "Agent is shopping…";
  $("#agent-result").innerHTML = "";
  try {
    const r = await api("POST", "/api/agent/run", { goal });
    $("#agent-result").innerHTML = renderRun(r);
    const confirm = $("#confirm-btn");
    if (confirm) confirm.onclick = async () => {
      confirm.disabled = true;
      try { const o = await api("POST", `/api/orders/${r.order.id}/confirm`); location.href = o.approveUrl; } catch (err) { toast(err.message); confirm.disabled = false; }
    };
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run agent";
  }
});

function renderChecks(checks) {
  return `<table class="checks">${checks.map((c) => `<tr><td>${badge(c.severity)}</td><td><b>${esc(c.rule.replace(/_/g, " "))}</b></td><td>${esc(c.detail)}</td></tr>`).join("")}</table>`;
}

function renderRun(r) {
  let html = `<div class="card"><h3>Agent run <span class="muted">(${r.engine === "claude" ? "Claude" : "rule-based fallback"})</span></h3>`;
  if (r.error) html += `<p class="flags">${esc(r.error)}</p>`;
  if (r.message) html += `<div class="agent-msg">${esc(r.message)}</div>`;
  html += `<ul class="trace">${r.trace.filter((t) => t.kind === "tool").map((t) => `<li class="tool">→ ${esc(t.name)}(${esc(JSON.stringify(t.input))}) — ${esc(t.summary)}</li>`).join("")}</ul>`;
  const o = r.order;
  if (o) {
    html += `<div class="decision ${o.guardDecision}"><b>${esc(o.productName)}</b> from ${esc(o.merchantName)} — <b>${money(o.amount)}</b> ${badge(o.guardDecision)}<br>`;
    if (o.status === "NEEDS_USER_OK") html += `<p>This is above your auto-approve threshold, so the agent needs your OK.</p><button class="primary" id="confirm-btn">Approve &amp; pay with PayPal</button>`;
    else if (o.approveUrl) html += `<p>PayPal order <code>${esc(o.paypalOrderId)}</code> created. Funds are only held after you approve, and captured when the merchant delivers.</p><a class="paylink" href="${esc(o.approveUrl)}">Pay with PayPal</a>`;
    html += renderChecks(o.checks) + `</div>`;
  }
  for (const c of r.checks.filter((x) => x.decision === "block")) {
    html += `<details class="decision block"><summary><b>Blocked:</b> ${esc(c.productName)} from ${esc(c.merchantName)} (${money(c.amount)})</summary>${renderChecks(c.checks)}</details>`;
  }
  if (!o && !r.checks.some((x) => x.decision === "block") && !r.error) html += `<p class="muted">No purchase was made.</p>`;
  return html + `</div>`;
}

// ---------------------------------------------------------------- merchant onboarding
const SAMPLE = `Mitti & Wax — handmade soy candles, Jaipur 🕯️
Lavender calm candle (200g) - ₹650
Sandalwood temple jar candle - ₹890
Diwali gift set of 3 mini candles - ₹1,200
Hand-painted ceramic diya pair - ₹450
Shipping across India in 3-4 days, Jaipur same day.
Easy returns: if a candle arrives broken, we replace it or refund within 7 days.
DM to order or pay via the link!`;

$("#ob-sample").addEventListener("click", () => { $("#ob-text").value = SAMPLE; $("#ob-url").value = ""; });

$("#onboard-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#ob-btn");
  btn.disabled = true;
  btn.textContent = "Reading your shop…";
  try {
    const r = await api("POST", "/api/merchants/preview", { text: $("#ob-text").value, url: $("#ob-url").value.trim() });
    pendingCatalog = r.catalog;
    renderCatalog(r);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Extract catalog";
  }
});

function renderCatalog(r) {
  const c = r.catalog;
  const notes = [r.note, c.warning].filter(Boolean).map((n) => `<p class="muted">${esc(n)}</p>`).join("");
  $("#onboard-result").innerHTML = `<div class="card">
    <h3>${esc(c.name)} <span class="muted">(${c.engine === "claude" ? "extracted by Claude" : "rule-based extraction"})</span></h3>${notes}
    <p class="muted"><b>Refund policy:</b> ${esc(c.refundPolicy || "none found")}<br><b>Delivery:</b> ${esc(c.deliveryPolicy || "not stated")}</p>
    ${c.redFlags?.length ? `<p class="flags">⚠ ${c.redFlags.map(esc).join(" · ")}</p>` : ""}
    <table class="products"><tr><th>Product</th><th>USD</th><th>Category</th><th>Days</th></tr>
    ${c.products.map((p, i) => `<tr><td><input data-i="${i}" data-k="name" value="${esc(p.name)}"></td><td><input data-i="${i}" data-k="price" type="number" step="0.01" value="${p.price}"></td><td>${esc(p.category)}</td><td><input data-i="${i}" data-k="deliveryDays" type="number" value="${p.deliveryDays}"></td></tr>`).join("")}
    </table><br>
    <button class="primary" id="publish-btn" ${c.products.length ? "" : "disabled"}>Publish to agents</button></div>`;
  $("#onboard-result").querySelectorAll("input[data-i]").forEach((inp) => inp.addEventListener("input", () => {
    const p = pendingCatalog.products[+inp.dataset.i];
    p[inp.dataset.k] = inp.type === "number" ? Number(inp.value) : inp.value;
  }));
  $("#publish-btn").onclick = async () => {
    try {
      const m = await api("POST", "/api/merchants", { catalog: pendingCatalog, paypalEmail: $("#ob-email").value.trim() });
      toast(`${m.name} is agent-ready (trust ${m.trust.score}/100)`);
      $("#onboard-result").innerHTML = "";
      await refresh();
    } catch (err) { toast(err.message); }
  };
}

// ---------------------------------------------------------------- mandate
$("#mandate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api("PUT", "/api/mandate", {
      perOrderLimit: f.get("perOrderLimit"), dailyLimit: f.get("dailyLimit"), askAbove: f.get("askAbove"),
      minMerchantTrust: f.get("minMerchantTrust"), allowedCategories: f.getAll("cat"), requireRefundPolicy: f.get("requireRefundPolicy") === "on",
    });
    document.activeElement?.blur();
    toast("Mandate saved");
    await refresh();
  } catch (err) { toast(err.message); }
});

$("#reset-btn").addEventListener("click", async () => {
  if (!confirm("Reset all orders, events and onboarded merchants?")) return;
  await api("POST", "/api/reset");
  await refresh();
  toast("Demo data reset");
});

// ---------------------------------------------------------------- boot
(async () => {
  await refresh();
  const params = new URLSearchParams(location.search);
  if (params.get("paid")) {
    toast("Approved on PayPal: funds are held until the merchant delivers");
    history.replaceState(null, "", location.pathname + location.hash);
  }
  const tab = (location.hash || "#shop").slice(1);
  showTab(["shop", "merchant", "orders", "mandate"].includes(tab) ? tab : "shop");
})();
