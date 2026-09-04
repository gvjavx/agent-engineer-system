#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// A terminal front for the same agent WhatsApp drives. It POSTs each line to
// the running orchestrator's /cli/message and prints replies streamed back
// over /cli/stream (SSE). Needs CLI_ENABLED=true on the orchestrator and the
// shared INTERNAL_SHARED_SECRET.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load the monorepo's root .env when present (apps/cli/dist -> repo root), so
// running from a checkout Just Works. dotenv is optional — a standalone copy
// with the env vars exported directly still runs.
try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env"), quiet: true });
  dotenv.config({ quiet: true }); // also a .env in the current dir, if any
} catch {
  /* no dotenv installed — rely on the process environment */
}

const BASE = (process.env.ORCHESTRATOR_URL ?? "http://localhost:4000").replace(/\/$/, "");
const SECRET = process.env.INTERNAL_SHARED_SECRET;
if (!SECRET) {
  console.error("INTERNAL_SHARED_SECRET belum keset (di .env repo root atau di environment).");
  process.exit(1);
}

async function send(text: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/cli/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET! },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error(`gak bisa nyambung ke ${BASE}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (res.status === 403) {
    console.error("CLI dimatiin di orchestrator — set CLI_ENABLED=true di .env-nya, terus restart.");
    process.exit(1);
  }
  if (res.status !== 202) console.error(`orchestrator nolak (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

async function* streamReplies(replay: boolean, signal: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(`${BASE}/cli/stream${replay ? "?replay=1" : ""}`, {
    headers: { "X-Internal-Secret": SECRET! },
    signal,
  });
  if (res.status === 403) throw new Error("CLI dimatiin di orchestrator — set CLI_ENABLED=true di .env-nya.");
  if (res.status === 401) throw new Error("INTERNAL_SHARED_SECRET-nya gak cocok sama orchestrator.");
  if (!res.ok || !res.body) throw new Error(`stream gagal (${res.status})`);

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const evt = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = evt
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("");
      if (!data) continue; // keepalive comment
      try {
        yield JSON.parse(data) as string;
      } catch {
        /* not a data event we care about */
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const message = args.filter((a) => !a.startsWith("--")).join(" ");
  const waitArg = args.find((a) => a.startsWith("--wait="));
  const idleMs = Math.max(1, waitArg ? Number(waitArg.split("=")[1]) : 8) * 1000;

  const ac = new AbortController();
  const quit = (code = 0) => {
    ac.abort();
    process.exit(code);
  };
  process.on("SIGINT", () => quit(0));

  if (message) {
    // one-shot: send first (so a 403/401 exits cleanly), then print replies
    // until the stream stays quiet for idleMs.
    await send(message);
    let idle: NodeJS.Timeout | undefined;
    const bump = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => quit(0), idleMs);
    };
    bump();
    try {
      for await (const line of streamReplies(false, ac.signal)) {
        console.log(line);
        bump();
      }
    } catch (e) {
      if (!ac.signal.aborted) console.error("stream putus:", e instanceof Error ? e.message : String(e));
      quit(1);
    }
    return;
  }

  // interactive REPL
  console.log(`Mas ADE CLI → ${BASE}  (Ctrl+C buat keluar)`);
  void (async () => {
    for await (const line of streamReplies(true, ac.signal)) console.log(line);
  })().catch((e) => {
    if (!ac.signal.aborted) console.error("stream putus:", e instanceof Error ? e.message : String(e));
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  rl.on("line", async (line) => {
    const t = line.trim();
    if (t) await send(t);
    rl.prompt();
  });
  rl.on("close", () => quit(0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
