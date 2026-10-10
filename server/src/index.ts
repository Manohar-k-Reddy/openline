import { createGatewayServer } from "./server.js";

const apiKey = process.env.HTTP_GATEWAY_API_KEY;
if (!apiKey) {
  console.error("HTTP_GATEWAY_API_KEY is required");
  process.exit(1);
}

const port = parsePort(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "0.0.0.0";
const gateway = createGatewayServer({
  apiKey,
  webhookSecret: process.env.WEBHOOK_SECRET,
  defaultWebhookUrl: process.env.WEBHOOK_URL,
  geminiApiKey: process.env.GEMINI_API_KEY,
  agentModel: process.env.GEMINI_LIVE_MODEL,
  agentOwnerName: process.env.AGENT_OWNER_NAME,
  dataDir: process.env.DATA_DIR ?? "data",
  publicUrl: process.env.PUBLIC_URL,
  docsUrl: process.env.DOCS_URL,
});

gateway.httpServer.listen(port, host, () => {
  console.log(`OpenLine server listening on http://${host}:${port}`);
  console.log(
    gateway.agents.configured
      ? `AI assistant ready (${gateway.agents.model}); console: http://localhost:${port}/`
      : "AI assistant off until a Gemini API key is set (console Settings or GEMINI_API_KEY)",
  );
});

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid PORT: ${value}`);
  }
  return parsed;
}
