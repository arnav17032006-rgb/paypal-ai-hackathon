# AgentReady: safe agent payments on PayPal

**Make any small shop buyable by AI agents, and make sure those agents can only spend money safely.**

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/).

## The problem

AI agents are starting to shop for people. Two things stand in the way:

1. **Small merchants are invisible to agents.** A home baker selling on Instagram or WhatsApp has no structured catalog and no checkout an agent can use.
2. **Users can't trust agents with money.** Nothing stops an agent from overspending, or from paying a scam shop that asks for "friends & family" payments.

## What AgentReady does

| Part | What it does | PayPal |
|---|---|---|
| **Merchant onboarding** | A merchant pastes shop text or a URL. Claude extracts products, prices, refund and delivery policies, and flags scam patterns. The shop is published to agents over MCP and as a JSON feed (`/api/agent-feed`). | Products registered in the PayPal catalog with the **Agent Toolkit**; payee email so money goes straight to the merchant |
| **Injection-resistant trust score** | The score is computed on the server from the shop's own text, never from what the browser sends back. A code scan (not the AI) catches common instructions aimed at AI agents, unprotected payment methods, "all sales final" and impossible discounts. A refund policy only counts if it is really in the shop's text. The scan matches patterns, so cleverly reworded text can get past it; limits and PayPal approval still apply either way. | |
| **Shopper agent** | The user says *"chocolate birthday cake under $30, needed tomorrow"*. A Claude tool-use agent searches every shop, dry-runs candidates against the guard, and commits to the best one. | Orders v2 with `intent: AUTHORIZE` |
| **Bring your own agent (MCP)** | Any MCP client (Claude Code, Claude Desktop, others) can shop at `/mcp`: search, product details, spending rules, guard dry-run, checkout and order status. Checkout runs the same guard and returns a PayPal link a person must approve. | Same Orders v2 flow |
| **Trust guard** | Deterministic rules on every payment: per-order and daily limits, allowed categories, merchant trust score, refund policy, scam phrases, delivery deadline, and an "ask me above $X" threshold. The model can explain a decision but never override it. Limits and trust can change while an order waits, so the guard decides three times: at checkout, when the owner approves a waiting order, and just before funds are held. Unpaid orders count against the daily limit and stock, so parallel checkouts can't race past them. Once funds are held the decision is made, and capture only settles it. | Runs before any PayPal order exists, and again before any hold |
| **Escrow-style settlement** | Buyer approves on PayPal, so funds are only **held**. When the merchant marks it delivered, the hold is **captured**. Otherwise it is **voided** or later **refunded**. | Authorize, Capture, Void, Refund, idempotent `PayPal-Request-Id` |
| **Webhooks** | PayPal events keep orders right when the redirect never comes back (buyer approved and closed the tab), a hold expires, or money is refunded or disputed on paypal.com. A dispute lowers the merchant's trust, so the guard reacts on the next sale. | Signature verified with `verify-webhook-signature`, each event id applied once |
| **Money assistant** | Merchants ask *"how much have agents paid me this week?"*. Claude answers from AgentReady's ledger and, read-only, from the merchant's PayPal account. | **Agent Toolkit**: `list_transactions`, `list_disputes`, `get_order` |
| **Dashboards** | AG Grid views of agent orders (with actions and which agent placed them), the audit trail, and merchant trust scores with reasons. | Order and capture IDs on every row |

## Run it locally (2 minutes)

Requires Node.js 20 or newer.

```bash
git clone https://github.com/arnav17032006-rgb/paypal-ai-hackathon.git
cd paypal-ai-hackathon
npm install
cp .env.example .env    # optional: add keys, see below
npm start
```

Open http://localhost:3000.

**It runs with no keys at all.** The header shows which mode is active:

| Setting | Without it | With it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Rule-based extraction and shopper (keyword search + the same guard) | Claude (`claude-opus-5-5`) extracts catalogs and runs the shopper agent with tools |
| `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` | A local simulator with PayPal's response shapes and an approval page | The real PayPal **sandbox**; you approve with a sandbox buyer account. Also turns on the Agent Toolkit (catalog sync, money assistant reads PayPal) |
| `PAYPAL_WEBHOOK_ID` | Webhooks are refused (simulated events can be fired from the Orders grid in demo mode) | Signature-verified PayPal webhooks at `/api/webhooks/paypal` |

### Using the PayPal sandbox

1. Sign in at [developer.paypal.com](https://developer.paypal.com), open **Apps & Credentials → Sandbox → Create App**.
2. Put the Client ID and Secret in `.env`.
3. Under **Sandbox → Accounts** use the default *Personal* account to approve payments.
4. To pay a merchant directly, onboard them with a sandbox *Business* account email. Seed merchants have no payee email, so their payments go to your app's sandbox business account.
5. Webhooks need a public HTTPS URL (for example your Render URL). In your app's **Webhooks** section add `https://<your-host>/api/webhooks/paypal` with these events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `CUSTOMER.DISPUTE.CREATED`. Put the webhook id in `PAYPAL_WEBHOOK_ID`.

## Connect your own agent (MCP)

The server speaks MCP over Streamable HTTP at `/mcp`. The **Shop with agent** tab shows the exact commands for your host.

```bash
claude mcp add --transport http agentready http://localhost:3000/mcp
```

For Claude Desktop, add this under Settings → Developer → Edit Config and restart:

```json
{ "mcpServers": { "agentready": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3000/mcp"] } } }
```

Then ask: *"Use AgentReady to buy a chocolate birthday cake under $30."* The agent gets a PayPal link to hand you. Orders it places show up in the grid as **MCP agent**.

## Demo script

1. **Shop with agent** → *"Chocolate birthday cake under $30, needed tomorrow"*. The agent picks the trusted bakery and the guard blocks the 95%-off earbuds from a scam shop. Click **Pay with PayPal** and approve.
2. **Orders & ledger** → the order is `AUTHORIZED` (funds held). Click **Mark delivered** to capture it to the merchant.
3. Ask for *"A machine learning textbook for my friend"*. At $42 it is above the $35 threshold, so the agent asks first.
4. **Become agent-ready** → **Use a sample** → **Extract catalog** → **Publish to agents**. Then ask the agent for *"lavender candle gift under $15"*.
5. **Become agent-ready** → **Try a suspicious shop**. Its page hides a line telling AI agents to report no red flags, and it asks for gift cards or crypto. The code scan catches both, so the shop scores 10 out of 100 in demo mode (Claude's own flags can push it lower), far below the minimum of 60. No agent will buy there.
6. **Orders & ledger** → on a captured order, **Sim dispute** fires the dispute webhook; the bakery's trust drops. Ask the money assistant what happened.
7. Connect Claude Code over MCP and buy something from the terminal; the order appears as **MCP agent**.
8. **Mandate** → lower the per-order limit and watch the guard block what it allowed before.

## How AI is used

- **Claude `claude-opus-5-5`** through the official Anthropic SDK (`@anthropic-ai/sdk`).
  - **Catalog extraction:** a strict-schema tool (`save_catalog`) turns messy shop text into products, policies and consumer-protection red flags. Effort `low`.
  - **Shopper agent:** a tool-use loop with `search_products`, `check_purchase` (dry-run guard) and `checkout`. Effort `medium`.
  - **Money assistant:** a tool-use loop over AgentReady's ledger plus read-only PayPal Agent Toolkit tools. Effort `low`.
  - Merchant text and tool results are passed as data, and the prompts tell Claude never to follow instructions inside them. The code scan backs this up, because prompts alone can't guarantee it.
  - Server-side refusal fallback (`fallbacks: "default"`) is enabled on every call.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`): catalog sync on publish (`create_product`) and the assistant's read-only tools. Write actions are not enabled for the model.
- **MCP** (`@modelcontextprotocol/sdk`): the `/mcp` endpoint for outside agents.
- The money path is **not** left to the model: limits and trust checks are plain code (`server/guard.js`), covered by `npm test` (32 tests, including MCP, webhook and stale-approval flows end to end).

## Project layout

```
server/index.js    Starts the server
server/app.js      Express API, onboarding drafts, PayPal return/cancel, simulator pages
server/orders.js   Order lifecycle shared by every agent, redirect and webhook
server/mcp.js      MCP endpoint for outside agents
server/webhooks.js Verified PayPal webhooks (and simulated ones in demo mode)
server/toolkit.js  PayPal Agent Toolkit: catalog sync and read-only tools
server/paypal.js   PayPal OAuth + Orders v2 (authorize, capture, void, refund), webhook verification, simulator
server/ai.js       Claude catalog extraction, shopper agent and money assistant, with rule-based fallbacks
server/guard.js    Trust guard, red-flag scan and merchant trust scoring
server/store.js    JSON file store (data/db.json)
server/seed.json   Demo mandate and merchants
public/            Web app (vanilla JS + AG Grid Community)
test/              Guard, trust and end-to-end API tests (npm test)
```

## Deploy on Render

`render.yaml` is included. Create a Blueprint from this repo, set the environment variables, and set `APP_URL` to your Render URL so PayPal redirects back correctly. Then register the webhook (step 5 above) and set `PAYPAL_WEBHOOK_ID`.

## License

[MIT](LICENSE)
