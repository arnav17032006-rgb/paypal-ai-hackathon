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
| **Merchant onboarding** | A merchant pastes shop text or a URL. Claude extracts products, prices, refund and delivery policies, and flags scam patterns. The shop is published as an agent-readable feed (`/api/agent-feed`). | Payee email, so money goes straight to the merchant |
| **Shopper agent** | The user says *"chocolate birthday cake under $30, needed tomorrow"*. A Claude tool-use agent searches every shop, dry-runs candidates against the guard, and commits to the best one. | Orders v2 with `intent: AUTHORIZE` |
| **Trust guard** | Deterministic rules on every payment: per-order and daily limits, allowed categories, merchant trust score, refund policy, scam phrases, delivery deadline, and an "ask me above $X" threshold. The model can explain a decision but never override it, and checkout is re-checked on the server. | Runs before any PayPal order exists |
| **Escrow-style settlement** | Buyer approves on PayPal, so funds are only **held**. When the merchant marks it delivered, the hold is **captured**. Otherwise it is **voided** or later **refunded**. | Authorize, Capture, Void, Refund, idempotent `PayPal-Request-Id` |
| **Dashboards** | AG Grid views of agent orders (with actions), the audit trail, and merchant trust scores with reasons. | Order and capture IDs on every row |

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
| `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` | A local simulator with PayPal's response shapes and an approval page | The real PayPal **sandbox**; you approve with a sandbox buyer account |

### Using the PayPal sandbox

1. Sign in at [developer.paypal.com](https://developer.paypal.com), open **Apps & Credentials → Sandbox → Create App**.
2. Put the Client ID and Secret in `.env`.
3. Under **Sandbox → Accounts** use the default *Personal* account to approve payments.
4. To pay a merchant directly, onboard them with a sandbox *Business* account email. Seed merchants have no payee email, so their payments go to your app's sandbox business account.

## Demo script

1. **Shop with agent** → *"Chocolate birthday cake under $30, needed tomorrow"*. The agent picks the trusted bakery and the guard blocks the 95%-off earbuds from a scam shop. Click **Pay with PayPal** and approve.
2. **Orders & ledger** → the order is `AUTHORIZED` (funds held). Click **Mark delivered** to capture it to the merchant.
3. Ask for *"A machine learning textbook for my friend"*. At $42 it is above the $35 threshold, so the agent asks first.
4. **Become agent-ready** → **Use a sample** → **Extract catalog** → **Publish to agents**. Then ask the agent for *"lavender candle gift under $15"*.
5. **Mandate** → lower the per-order limit and watch the guard block what it allowed before.

## How AI is used

- **Claude `claude-opus-5-5`** through the official Anthropic SDK (`@anthropic-ai/sdk`).
  - **Catalog extraction:** a strict-schema tool (`save_catalog`) turns messy shop text into products, policies and consumer-protection red flags. Effort `low`.
  - **Shopper agent:** a tool-use loop with `search_products`, `check_purchase` (dry-run guard) and `checkout`. Effort `medium`.
  - Server-side refusal fallback (`fallbacks: "default"`) is enabled on every call.
- The money path is **not** left to the model: limits and trust checks are plain code (`server/guard.js`) with unit tests.

## Project layout

```
server/index.js    Express API, PayPal return/cancel handlers, simulator approval page
server/paypal.js   PayPal OAuth + Orders v2 (authorize, capture, void, refund) and the simulator
server/ai.js       Claude catalog extraction + shopper agent, with rule-based fallbacks
server/guard.js    Trust guard and merchant trust scoring
server/store.js    JSON file store (data/db.json)
server/seed.json   Demo mandate and merchants
public/            Web app (vanilla JS + AG Grid Community)
test/              Guard unit tests (npm test)
```

## Deploy on Render

`render.yaml` is included. Create a Blueprint from this repo, set the environment variables, and set `APP_URL` to your Render URL so PayPal redirects back correctly.

## License

[MIT](LICENSE)
