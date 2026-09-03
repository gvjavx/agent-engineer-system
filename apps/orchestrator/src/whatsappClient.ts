import { config } from "./config.js";
import { conversationRepo, sessionRepo } from "./db/index.js";

export interface QuickReplyOption {
  // Sent back verbatim as the inbound message text when tapped — should be
  // exactly what the user would've typed by hand (e.g. "ya", "pakai demo").
  id: string;
  title: string;
  description?: string;
}

// Optional side-channel: router/handler.ts registers a hook that, right after
// a voice note comes in, voices the first substantive text reply. Kept as a
// callback so this module stays decoupled from TTS. Every send calls it; the
// hook itself decides whether this particular (to, text) should be spoken.
type VoiceReplyHook = (to: string, text: string) => void;
let voiceReplyHook: VoiceReplyHook | undefined;
export function setVoiceReplyHook(hook: VoiceReplyHook | undefined): void {
  voiceReplyHook = hook;
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
      return;
    }
    // Only logged on confirmed delivery to the gateway — a failed send
    // shouldn't leave a transcript entry for something the user never got.
    // Reads the recipient's current session fresh each call rather than
    // threading a session id through every sendWhatsApp call site across
    // handler.ts (dozens of them, including deep inside the async task
    // pipeline) — see router/handler.ts's touchAndLogSession for how that
    // session id gets set in the first place.
    const sessionId = conversationRepo.get(to)?.current_session_id;
    if (sessionId) sessionRepo.append(to, sessionId, "assistant", text);

    voiceReplyHook?.(to, text);
  } catch (err) {
    console.error("Failed to reach whatsapp-gateway:", err);
  }
}

export async function sendWhatsAppAudio(to: string, mp3Base64: string): Promise<void> {
  const res = await fetch(`${config.gatewayUrl}/send-audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": config.internalSharedSecret },
    body: JSON.stringify({ to, mp3Base64 }),
  });
  if (!res.ok) {
    throw new Error(`Gateway rejected audio (${res.status}): ${await res.text()}`);
  }
}

// Unlike sendWhatsApp above, this doesn't swallow errors — the caller (the
// send_document tool's handler) needs to know it failed so it can tell the
// AI, which tells the user, rather than silently losing the file.
export async function sendWhatsAppDocument(
  to: string,
  filename: string,
  mimeType: string,
  contentBase64: string,
  caption?: string
): Promise<void> {
  const res = await fetch(`${config.gatewayUrl}/send-document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": config.internalSharedSecret,
    },
    body: JSON.stringify({ to, filename, mimeType, caption, contentBase64 }),
  });
  if (!res.ok) {
    throw new Error(`Gateway rejected document (${res.status}): ${await res.text()}`);
  }
}
