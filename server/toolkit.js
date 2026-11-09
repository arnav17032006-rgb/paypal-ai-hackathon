// PayPal Agent Toolkit: registers onboarded products in the merchant's PayPal catalog,
// and gives the money assistant read-only access to PayPal's own records. Needs sandbox keys.

import { PayPalMCPToolkit } from "@paypal/agent-toolkit/mcp";
import * as paypal from "./paypal.js";
import * as store from "./store.js";

export const toolkitReady = paypal.paypalMode === "sandbox";

// The assistant can look, never move money: no create/send/refund/accept actions are enabled.
export const READ_ONLY = {
  transactions: { list: true },
  disputes: { list: true, get: true },
  orders: { get: true },
  products: { list: true },
  invoices: { list: true },
};
const CATALOG_WRITE = { products: { create: true } };

/** Run one toolkit tool. Arguments are validated (and defaulted) by the toolkit's own schema first. */
export async function run(method, args = {}, actions = READ_ONLY) {
  if (!toolkitReady) throw new Error("PayPal Agent Toolkit needs PayPal sandbox keys");
  const kit = new PayPalMCPToolkit({
    accessToken: await paypal.accessToken(),
    configuration: { actions, context: { sandbox: paypal.isSandbox } },
  });
  const tool = kit.getTools().find((t) => t.method === method);
  if (!tool) throw new Error(`PayPal tool ${method} is not enabled`);
  const parsed = tool.parameters.safeParse(args);
  if (!parsed.success) throw new Error(`Invalid arguments for ${method}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const out = JSON.parse(await kit.getPaypalAPIService().run(method, parsed.data));
  if (out?.error) throw new Error(`PayPal ${method}: ${out.error.message || JSON.stringify(out.error)}`);
  return out;
}

/** Create each new product in the PayPal catalog (Catalog Products API) and keep its PayPal id. */
export async function syncCatalog(merchant) {
  if (!toolkitReady) return;
  let done = 0;
  for (const p of merchant.products) {
    if (p.paypalProductId) continue;
    try {
      const created = await run("create_product", {
        name: p.name.slice(0, 127),
        type: "PHYSICAL",
        description: `${merchant.name}: ${p.name}`.slice(0, 256),
      }, CATALOG_WRITE);
      p.paypalProductId = created.id;
      done += 1;
    } catch (err) {
      store.log("paypal", `Could not add ${p.name} to the PayPal catalog: ${err.message}`, { merchantId: merchant.id });
    }
  }
  if (done) store.log("paypal", `Added ${done} of ${merchant.name}'s products to the PayPal catalog (Agent Toolkit)`, { merchantId: merchant.id });
  store.save();
}
