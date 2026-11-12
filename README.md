# AgentReady: safe agent payments on PayPal

[![CI](https://github.com/arnav17032006-rgb/paypal-ai-hackathon/actions/workflows/ci.yml/badge.svg)](https://github.com/arnav17032006-rgb/paypal-ai-hackathon/actions/workflows/ci.yml)

**Make any small shop buyable by AI agents, and make sure those agents can only spend money safely.**

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/).

**Live demo:** https://agentready-6odi.onrender.com (click **Demo buyer** or **Demo shop owner**; the free instance can take about a minute to wake up)

| | |
|---|---|
| ![The agent picks a trusted bakery and the guard blocks a scam shop](docs/screenshots/1-agent-run.jpg) | ![A shop with a hidden instruction for AI agents scores 10 out of 100](docs/screenshots/2-suspicious-shop.jpg) |
| ![Merchants see which rule stopped each sale and what to do](docs/screenshots/3-why-agents-didnt-buy.jpg) | ![Orders, holds and captures in AG Grid](docs/screenshots/4-orders-ledger.jpg) |
| ![Every shop with its trust score and what the buyer's rules allow](docs/screenshots/6-agent-ready-shops.jpg) | ![One order: where it is, PayPal ids and the full guard report](docs/screenshots/7-order-guard-report.jpg) |
| ![Spending rules with the guard's live verdict on every product](docs/screenshots/8-spending-rules.jpg) | ![Login page with one-click demo accounts](docs/screenshots/5-login.jpg) |

Screenshots are from demo mode (no keys).

## What you see

- **Buyer:** a goal box for the agent, a step-by-step run (search, each guard check, checkout), the guardrails with today's spend, and an inbox of payments waiting for approval. **Agent-ready shops** lists every shop with its trust score and, per product, what the buyer's rules allow. **Spending rules** shows the guard's real verdict on every listed product ("agent can buy", "asks you first", "blocked"), from the same code path as a real checkout.
- **Shop owner:** shop cards with a trust gauge and an agent-readiness checklist, **Why agents didn't buy** with the blocking rules as a chart, and **Orders & payouts** with a bar showing where the money is (waiting, held, paid, refunded).
- **Any order:** click a row for its lifecycle, PayPal ids and the full guard report.
- Light and dark themes, and a phone layout.

## The problem

AI agents are starting to shop for people. Two things stand in the way:

1. **Small merchants are invisible to agents.** A home baker selling on Instagram or WhatsApp has no structured catalog and no checkout an agent can use.
2. **Users can't trust agents with money.** Nothing stops an agent from overspending, or from paying a scam shop that asks for "friends & family" payments.

## What AgentReady does

| Part | What it does | PayPal |
|---|---|---|
| **Accounts for both sides** | Sign up or log in as a **buyer** or a **shop owner**, and each sees only their side. Buyers get their own spending rules, orders and agent key; shop owners see only their own shops, orders, payouts and lost sales. Passwords are stored as salted scrypt hashes, sessions are HttpOnly cookies, and every action is checked on the server for the right role and owner. One-click demo accounts let judges try both sides without signing up. | |
| **Merchant onboarding** | A merchant pastes shop text or a URL. Claude extracts products, prices, refund and delivery policies, and flags scam patterns. The shop is published to agents over MCP and as a JSON feed (`/api/agent-feed`). | Products registered in the PayPal catalog with the **Agent Toolkit**; payee email so money goes straight to the merchant |
| **Injection-resistant trust score** | The score is computed on the server from the shop's own text, never from what the browser sends back. A code scan (not the AI) catches common instructions aimed at AI agents, unprotected payment methods, "all sales final" and impossible discounts. A refund policy only counts if it is really in the shop's text. The scan matches patterns, so cleverly reworded text can get past it; limits and PayPal approval still apply either way. | |
| **Shopper agent** | The user says *"chocolate birthday cake under $30, needed tomorrow"*. A Claude tool-use agent searches every shop, dry-runs candidates against the guard, and commits to the best one. | Orders v2 with `intent: AUTHORIZE` |
| **Bring your own agent (MCP)** | Any MCP client (Claude Code, Claude Desktop, others) can shop at `/mcp`: search, product details, spending rules, guard dry-run, checkout and order status. Checkout runs the same guard and returns a PayPal link a person must approve. | Same Orders v2 flow |
| **Trust guard** | Deterministic rules on every payment: per-order and daily limits, allowed categories, merchant trust score, refund policy, scam phrases, delivery deadline, and an "ask me above $X" threshold. The model can explain a decision but never override it. Limits and trust can change while an order waits, so the guard decides three times: at checkout, when the owner approves a waiting order, and just before funds are held. Unpaid orders count against the daily limit and stock, so parallel checkouts can't race past them. Once funds are held the decision is made, and capture only settles it. | Runs before any PayPal order exists, and again before any hold |
| **Escrow-style settlement** | Buyer approves on PayPal, so funds are only **held**. When the merchant marks it delivered, the hold is **captured**. Otherwise it is **voided** or later **refunded**. | Authorize, Capture, Void, Refund, idempotent `PayPal-Request-Id` |
| **Webhooks** | PayPal events keep orders right when the redirect never comes back (buyer approved and closed the tab), a hold expires, or money is refunded or disputed on paypal.com. A dispute lowers the merchant's trust, so the guard reacts on the next sale. | Signature verified with `verify-webhook-signature`, each event id applied once |
| **Why agents didn't buy** | Every sale the guard stops is recorded per shop, product and rule. Merchants see how often each rule cost them a sale and what to do about it, for example publish a refund policy or remove risky payment wording. Rules that are the buyer's own limits say so. | |
| **Money assistant** | Merchants ask *"how much have agents paid me this week?"*. Claude answers from AgentReady's ledger and, read-only, from the merchant's PayPal account. | **Agent Toolkit**: `list_transactions`, `list_disputes`, `get_order` |
| **Dashboards** | AG Grid views of agent orders (with actions and which agent placed them), the audit trail, merchant trust scores with reasons, and lost sales. | Order and capture IDs on every row |

## Run it locally (2 minutes)

Requires Node.js 22 or newer.

```bash
git clone https://github.com/arnav17032006-rgb/paypal-ai-hackathon.git
cd paypal-ai-hackathon
npm install
cp .env.example .env    # optional: add keys, see below
npm start
```

Open http://localhost:3000. You land on the login page: create an account as a buyer or a shop owner, or click **Demo buyer** / **Demo shop owner**. The demo shop owner manages the three sample shops.

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

The server speaks MCP over Streamable HTTP at `/mcp`. The **Shop with agent** tab shows the exact commands for your host. A buyer's commands include their personal agent key (`Authorization: Bearer <key>`), so the agent shops under that buyer's own spending rules and orders. Without a key, the agent shops as the demo buyer.

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
2. Log in as the shop owner → **Orders & payouts** → the order is `AUTHORIZED` (funds held). Click **Mark delivered** to capture it to the merchant.
3. Ask for *"A machine learning textbook for my friend"*. At $42 it is above the $35 threshold, so the agent asks first.
4. **My shops** → **Use a sample shop** → **Extract catalog** → **Publish to agents**. Then ask the agent for *"lavender candle gift under $15"*.
5. **My shops** → **Try a suspicious shop**. Its page hides a line telling AI agents to report no red flags, and it asks for gift cards or crypto. The code scan catches both, so the shop scores 10 out of 100 in demo mode (Claude's own flags can push it lower), far below the minimum of 60. No agent will buy there.
6. **Orders & payouts** → on a captured order, **Sim dispute** fires the dispute webhook; the bakery's trust drops. Ask the money assistant what happened.
7. Connect Claude Code over MCP and buy something from the terminal; the order appears as **MCP agent**.
8. **Spending rules** → lower the per-order limit, save, and watch "What your saved rules allow" move products from allowed to blocked.

## How AI is used

- **Claude `claude-opus-5-5`** through the official Anthropic SDK (`@anthropic-ai/sdk`).
  - **Catalog extraction:** a strict-schema tool (`save_catalog`) turns messy shop text into products, policies and consumer-protection red flags. Effort `low`.
  - **Shopper agent:** a tool-use loop with `search_products`, `check_purchase` (dry-run guard) and `checkout`. Effort `medium`.
  - **Money assistant:** a tool-use loop over AgentReady's ledger plus read-only PayPal Agent Toolkit tools. Effort `low`.
  - Merchant text and tool results are passed as data, and the prompts tell Claude never to follow instructions inside them. The code scan backs this up, because prompts alone can't guarantee it.
  - Server-side refusal fallback (`fallbacks: "default"`) is enabled on every call.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`): catalog sync on publish (`create_product`) and the assistant's read-only tools. Write actions are not enabled for the model.
- **MCP** (`@modelcontextprotocol/sdk`): the `/mcp` endpoint for outside agents.
- The money path is **not** left to the model: limits and trust checks are plain code (`server/guard.js`), covered by `npm test` (42 tests, including MCP, webhook and stale-approval flows end to end).

## Project layout

```
server/index.js    Starts the server
server/app.js      Express API, accounts, onboarding drafts, PayPal return/cancel, simulator pages
server/auth.js     Password hashing, sessions and role checks
server/orders.js   Order lifecycle shared by every agent, redirect and webhook
server/mcp.js      MCP endpoint for outside agents
server/webhooks.js Verified PayPal webhooks (and simulated ones in demo mode)
server/toolkit.js  PayPal Agent Toolkit: catalog sync and read-only tools
server/paypal.js   PayPal OAuth + Orders v2 (authorize, capture, void, refund), webhook verification, simulator
server/ai.js       Claude catalog extraction, shopper agent and money assistant, with rule-based fallbacks
server/guard.js    Trust guard, red-flag scan and merchant trust scoring
server/store.js    JSON file store (data/db.json)
server/seed.json   Demo mandate and merchants
public/            Web app (vanilla JS + AG Grid Community, no build step), the login page and the shared icon set
test/              Guard, trust, accounts and end-to-end API tests (npm test)
.github/workflows/ CI: the tests on Node 22 and 24, plus a start-up check, on every push
DEVPOST_SUBMISSION.md  Hackathon write-up, testing steps for judges and the video script
```

## Limitations

- **Sandbox only.** No real money moves. Without PayPal keys the app uses a local simulator that mirrors PayPal's responses, and the header says so.
- **The demo shops are seed data.** Their order counts, disputes and trust scores are made up for the demo. Only shops you onboard are scored from their own text.
- **The red-flag scan matches patterns.** Reworded scam text or a new kind of injection can get past it. Spending limits and the buyer's PayPal approval still apply.
- **Simple accounts.** There is no email verification or password reset, and the demo accounts are shared by everyone who clicks them (only they can reset the demo data). The MCP endpoint without a key acts for the demo buyer.
- **A JSON file is the database.** It suits one server process. On a host without a persistent disk, data resets when the service restarts.
- **Seed merchants have no payee email,** so in the sandbox their payments go to the app's own business account. Paying a merchant directly needs their PayPal email at onboarding.

## Deploy on Render

`render.yaml` is included. Create a Blueprint from this repo, set the environment variables, and set `APP_URL` to your Render URL so PayPal redirects back correctly. Then register the webhook (step 5 above) and set `PAYPAL_WEBHOOK_ID`.

## License

[MIT](LICENSE)
