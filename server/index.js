import { app } from "./app.js";
import { aiMode } from "./ai.js";
import { paypalMode } from "./paypal.js";
import { webhookMode } from "./webhooks.js";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`AgentReady running at http://localhost:${PORT}  (AI: ${aiMode}, PayPal: ${paypalMode}, webhooks: ${webhookMode}, MCP: /mcp)`);
});
