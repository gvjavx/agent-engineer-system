import path from "node:path";
import { fileURLToPath } from "node:url";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/orchestrator/src -> repo root
const repoRoot = path.resolve(__dirname, "..", "..", "..");

export const config = {
  port: Number(process.env.ORCHESTRATOR_PORT ?? 4000),

  anthropicApiKey: required("ANTHROPIC_API_KEY"),

  githubToken: required("GITHUB_TOKEN"),

  internalSharedSecret: required("INTERNAL_SHARED_SECRET"),
  gatewayUrl: process.env.GATEWAY_URL ?? "http://whatsapp-gateway:3000",

  // Default WhatsApp number (E.164, no "+") to send unsolicited/global notices to.
  ownerNumber: required("OWNER_WHATSAPP_NUMBER"),

  workspacesDir: process.env.WORKSPACES_DIR ?? path.join(repoRoot, "workspaces"),
  dbPath: process.env.DB_PATH ?? path.join(repoRoot, "data", "orchestrator.sqlite"),

  claudeModel: process.env.CLAUDE_MODEL,
};
