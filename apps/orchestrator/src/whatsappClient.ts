import { config } from "./config.js";

export async function sendWhatsApp(to: string, text: string): Promise<void> {
  try {
    const res = await fetch(`${config.gatewayUrl}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": config.internalSharedSecret,
      },
      body: JSON.stringify({ to, text }),
    });
    if (!res.ok) {
      console.error(`Gateway rejected outbound message (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.error("Failed to reach whatsapp-gateway:", err);
  }
}
