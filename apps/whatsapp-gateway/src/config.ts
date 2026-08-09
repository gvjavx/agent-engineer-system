import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/whatsapp-gateway/src (or dist, once built) -> repo root
const repoRoot = path.resolve(__dirname, "..", "..", "..");

// Loads repo-root .env for local dev. In Docker, env vars come from the
// compose env_file instead and no .env exists in the image, so this is a
// harmless no-op there; either way it never overrides already-set vars.
dotenv.config({ path: path.join(repoRoot, ".env") });

export const config = {
  port: Number(process.env.PORT ?? 3000),

  // Meta WhatsApp Business Cloud API
  metaVerifyToken: required("META_VERIFY_TOKEN"),
  metaAppSecret: required("META_APP_SECRET"),
  metaAccessToken: required("META_ACCESS_TOKEN"),
  metaPhoneNumberId: required("META_PHONE_NUMBER_ID"),
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION ?? "v21.0",

  // Only these WhatsApp numbers (E.164, no "+") may issue commands.
  allowedSenders: (process.env.ALLOWED_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Internal service-to-service auth between gateway and orchestrator.
  internalSharedSecret: required("INTERNAL_SHARED_SECRET"),
  orchestratorUrl: process.env.ORCHESTRATOR_URL ?? "http://orchestrator:4000",
};
