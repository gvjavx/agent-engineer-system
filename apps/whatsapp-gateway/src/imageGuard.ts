// Allowlist, not blocklist — same default-deny principle as the orchestrator's
// documentGuard.ts. Meta's Cloud API already restricts inbound "image"
// messages to these two types client-side; this is defense in depth, not the
// primary gate.
const ALLOWED_INBOUND_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export function isAllowedInboundImageMimeType(mimeType: string): boolean {
  return ALLOWED_INBOUND_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

// WhatsApp's own documented inbound image ceiling — reject before ever
// spending an orchestrator round-trip or an AI vision call on it.
export const MAX_INBOUND_IMAGE_BYTES = 5 * 1024 * 1024;
