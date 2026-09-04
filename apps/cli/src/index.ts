#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// A terminal front for the same agent WhatsApp drives. It POSTs each line to
// the running orchestrator's /cli/message and prints replies streamed back
// over /cli/stream (SSE). Needs CLI_ENABLED=true on the orchestrator and the
// shared INTERNAL_SHARED_SECRET.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env"), quiet: true });
  dotenv.config({ quiet: true }); // also a .env in the current dir, if any
} catch {
  /* no dotenv installed — rely on the process environment */
}

const BASE = (process.env.ORCHESTRATOR_URL ?? "http://localhost:4000").replace(/\/$/, "");
const SECRET = process.env.INTERNAL_SHARED_SECRET;

// Sent by the orchestrator as the first SSE event — see /cli/stream.
const CLI_READY = " cli-ready";

// ── look & feel ─────────────────────────────────────────────────────────────

const COLOR =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint =
  (code: string) =>
  (s: string): string =>
    COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = paint("2");
const bold = paint("1");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const cyan = paint("36");
const magenta = paint("35");

const width = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const PROMPT = COLOR ? cyan("❯ ") : "> ";

function banner(): void {
  const inner = 52;
  const box = (s = "") => `${dim("│")} ${s}${" ".repeat(Math.max(0, inner - width(s)))} ${dim("│")}`;
  console.log(dim("╭" + "─".repeat(inner + 2) + "╮"));
  console.log(box(`${magenta("✳")}  ${bold("Mas ADE")} ${dim("— terminal")}`));
  console.log(box(dim(BASE)));
  console.log(dim("╰" + "─".repeat(inner + 2) + "╯"));
  console.log(dim("  Ketik instruksi bebas, atau command kaya di WhatsApp (status, pakai <project>, …)."));
  console.log(dim("  Ctrl+C buat keluar."));
  console.log();
}

// Render one streamed reply. First physical line gets a bullet; wrapped lines
// (and the "  [id] label" option rows) are indented under it.
function printReply(text: string): void {
  const lines = text.split("\n");
  const meta = /^\s*\[(sistem|file|gambar)[:\]]/.test(lines[0]);
  lines.forEach((raw, i) => {
    const line = raw.replace(/^\s*\[([a-z0-9/ ._-]+)\]\s?/i, (_m, id: string) => `${cyan(`[${id}]`)} `);
    if (i === 0) console.log(`${meta ? dim("·") : green("⏺")} ${meta ? dim(line) : line}`);
    else console.log(`  ${meta ? dim(line) : line}`);
  });
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinTimer: NodeJS.Timeout | undefined;
let spinStart = 0;
function startSpinner(label = "mikir"): void {
  if (!COLOR || spinTimer) return;
  spinStart = Date.now();
  let f = 0;
  const tick = () => {
    const secs = Math.floor((Date.now() - spinStart) / 1000);
    process.stdout.write(`\r${magenta(SPINNER[(f = (f + 1) % SPINNER.length)])} ${dim(`${label}… ${secs}s`)}\x1b[K`);
  };
  tick();
  spinTimer = setInterval(tick, 90);
}
function stopSpinner(): void {
  if (!spinTimer) return;
  clearInterval(spinTimer);
  spinTimer = undefined;
  process.stdout.write("\r\x1b[K");
}

// ── network ────────────────────────────────────────────────────────────────

async function send(text: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/cli/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET! },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    stopSpinner();
    console.error(red(`gak bisa nyambung ke ${BASE}: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  if (res.status === 403) {
    console.error(yellow("CLI dimatiin di orchestrator — set CLI_ENABLED=true di .env-nya, terus restart."));
    process.exit(1);
  }
  if (res.status !== 202) console.error(red(`orchestrator nolak (${res.status}): ${(await res.text()).slice(0, 200)}`));
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

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!SECRET) {
    console.error(red("INTERNAL_SHARED_SECRET belum keset (di .env repo root atau di environment)."));
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const message = args.filter((a) => !a.startsWith("--")).join(" ");
  const waitArg = args.find((a) => a.startsWith("--wait="));
  const idleMs = Math.max(1, waitArg ? Number(waitArg.split("=")[1]) : 8) * 1000;

  const ac = new AbortController();
  const quit = (code = 0): never => {
    stopSpinner();
    ac.abort();
    process.exit(code);
  };
  process.on("SIGINT", () => {
    if (COLOR) process.stdout.write("\r\x1b[K");
    quit(0);
  });

  // ── one-shot ──
  if (message) {
    // Subscribe before sending so a fast reply isn't missed. Wait for the
    // ready sentinel, or ~1.5s, whichever comes first (works even against an
    // orchestrator too old to send the sentinel).
    const gen = streamReplies(false, ac.signal);
    try {
      await Promise.race([gen.next(), new Promise((r) => setTimeout(r, 1500))]);
    } catch (e) {
      console.error(red(e instanceof Error ? e.message : String(e)));
      quit(1);
    }
    await send(message);
    startSpinner();
    let idle: NodeJS.Timeout | undefined;
    const bump = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => quit(0), idleMs);
    };
    bump();
    try {
      for await (const line of gen) {
        if (line === CLI_READY) continue;
        stopSpinner();
        printReply(line);
        startSpinner();
        bump();
      }
    } catch (e) {
      stopSpinner();
      if (!ac.signal.aborted) console.error(red("stream putus: " + (e instanceof Error ? e.message : String(e))));
      quit(1);
    }
    return;
  }

  // ── REPL ──
  banner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });

  let backToPrompt: NodeJS.Timeout | undefined;
  const armPrompt = () => {
    if (backToPrompt) clearTimeout(backToPrompt);
    // agent went quiet -> hand the prompt back
    backToPrompt = setTimeout(() => {
      stopSpinner();
      rl.resume();
      rl.prompt();
    }, 2500);
  };

  void (async () => {
    try {
      for await (const line of streamReplies(true, ac.signal)) {
        if (line === CLI_READY) continue;
        stopSpinner();
        printReply(line);
        startSpinner();
        armPrompt();
      }
    } catch (e) {
      stopSpinner();
      if (!ac.signal.aborted) console.error(red("stream putus: " + (e instanceof Error ? e.message : String(e))));
    }
  })();

  rl.prompt();
  rl.on("line", async (line) => {
    const t = line.trim();
    if (!t) return rl.prompt();
    rl.pause(); // agent's turn — prompt comes back on armPrompt()
    await send(t);
    startSpinner();
    armPrompt();
  });
  rl.on("close", () => quit(0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
