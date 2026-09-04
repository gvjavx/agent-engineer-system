import { config } from "../config.js";

// Outbound side of the CLI transport. The orchestrator normally sends replies
// to WhatsApp via the gateway; when the recipient is the CLI identity
// (config.cli.senderId), whatsappClient.ts hands the text here instead. The
// /cli/stream SSE route drains it, and a short ring buffer lets a CLI that
// (re)connects mid-task catch up on what it missed.

type Listener = (line: string) => void;

const listeners = new Set<Listener>();
const buffer: string[] = [];
const MAX_BUFFER = 300;

export function isCliSender(to: string): boolean {
  return config.cli.enabled && to === config.cli.senderId;
}

export function pushCliReply(text: string): void {
  buffer.push(text);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  for (const listener of listeners) {
    try {
      listener(text);
    } catch {
      /* a dead SSE connection shouldn't break the others */
    }
  }
}

export function attachCliListener(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentCliBuffer(): string[] {
  return [...buffer];
}

// Test-only.
export function resetCliChannelForTests(): void {
  listeners.clear();
  buffer.length = 0;
}
