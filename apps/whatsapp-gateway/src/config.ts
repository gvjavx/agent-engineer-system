function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

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
