import { config } from "./config.js";

export interface QuickReplyOption {
  // Sent back verbatim as the inbound message text when tapped — should be
  // exactly what the user would've typed by hand (e.g. "ya", "pakai demo").
  id: string;
  title: string;
  description?: string;
}

export async function sendWhatsApp(
  to: string,
  text: string,
  options?: QuickReplyOption[],
  listButtonLabel?: string
): Promise<void> {
  try {
    const res = await fetch(`${config.gatewayUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": config.internalSharedSecret,
      },
      body: JSON.stringify({ to, text, options, listButtonLabel }),
    });
    if (!res.ok) {
      console.error(`Gateway rejected outbound message (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.error("Failed to reach whatsapp-gateway:", err);
  }
}
