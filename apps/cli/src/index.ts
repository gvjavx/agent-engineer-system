#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// Terminal front for the same agent WhatsApp drives. POSTs each line to the
// running orchestrator's /cli/message and prints replies streamed back over
// /cli/stream (SSE). Needs CLI_ENABLED=true on the orchestrator + the shared
// INTERNAL_SHARED_SECRET.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env"), quiet: true });
  dotenv.config({ quiet: true });
} catch {
  /* no dotenv — rely on the environment */
}

const BASE = (process.env.ORCHESTRATOR_URL ?? "http://localhost:4000").replace(/\/$/, "");
const SECRET = process.env.INTERNAL_SHARED_SECRET;
const CLI_READY = " cli-ready"; // first SSE event from /cli/stream

// ── colours ────────────────────────────────────────────────────────────────

const TTY = process.stdout.isTTY === true;
const COLOR =
  (TTY || process.env.FORCE_COLOR === "1") && !process.env.NO_COLOR && process.env.TERM !== "dumb";
// The bordered-input frame + cursor tricks only make sense on a real
// interactive terminal; colour alone (e.g. FORCE_COLOR into a pipe) doesn't.
const FANCY = TTY && COLOR;

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

// One colour each for the A / D / E — the initials of Ai · Developer · Engineer.
const cA = paint("31"); // red
const cD = paint("33"); // yellow
const cE = paint("36"); // cyan
const acronym = (): string => `${bold("Mas")} ${cA("A")}${cD("D")}${cE("E")}`;
const titleFull = (): string =>
  `${bold("Mas")} ${dim("(")}${cA("A")}i ${cD("D")}eveloper ${cE("E")}ngineer${dim(")")}`;

// ── logo ───────────────────────────────────────────────────────────────────

const LOGO = [
  "█▀▄▀█ ▄▀█ █▀   ▄▀█ █▀▄ █▀▀",
  "█░▀░█ █▀█ ▄█   █▀█ █▄▀ ██▄",
];

function intro(): void {
  console.log();
  for (const row of LOGO) console.log("  " + magenta(row));
  console.log();
  console.log("  " + titleFull());
  console.log("  " + dim("AI dev team di terminal") + "   " + dim("·") + "   " + dim(BASE));
  console.log("  " + dim("Ketik instruksi bebas atau command WhatsApp (status, pakai <project>, tanya: …)."));
  console.log("  " + dim("Ctrl+C buat keluar."));
  console.log();
}

// ── reply rendering ────────────────────────────────────────────────────────

function printReply(text: string): void {
  const lines = text.split("\n");
  const meta = /^\s*\[(sistem|file|gambar)[:\]]/.test(lines[0]);
  lines.forEach((raw, i) => {
    const line = raw.replace(/^\s*\[([a-z0-9/ ._-]+)\]\s?/i, (_m, id: string) => `${cyan(`[${id}]`)} `);
    if (i === 0) console.log(`${meta ? dim("·") : green("⏺")} ${meta ? dim(line) : line}`);
    else console.log(`  ${meta ? dim(line) : line}`);
  });
}

// ── spinner ────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORDS = ["mikir", "nyusun", "ngerjain", "ngoprek", "nyari", "nulis"];
let spinTimer: NodeJS.Timeout | undefined;
let spinStart = 0;
let spinWord = WORDS[0];
function startSpinner(): void {
  if (!COLOR || spinTimer) return;
  spinStart = Date.now();
  spinWord = WORDS[Math.floor(Math.random() * WORDS.length)];
  let f = 0;
  const tick = () => {
    const s = Math.floor((Date.now() - spinStart) / 1000);
    process.stdout.write(`\r${magenta(FRAMES[(f = (f + 1) % FRAMES.length)])} ${dim(`${spinWord}… ${s}s`)}\x1b[K`);
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
      if (!data) continue;
      try {
        yield JSON.parse(data) as string;
      } catch {
        /* ignore */
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
    if (FANCY) process.stdout.write("\r\x1b[K");
    quit(0);
  });

  // ── one-shot ──
  if (message) {
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
  if (COLOR) intro();
  else console.log(`Mas ADE — ${BASE}  (Ctrl+C keluar)`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: FANCY ? "" : "> ",
    historySize: 200,
  });

  const frameWidth = () => Math.min(Math.max((process.stdout.columns || 80) - 2, 24), 78);
  let frameUp = false;

  // Three-line input frame: top rule with the label, the prompt line
  // (readline owns it), a bottom rule. Cursor is left on the prompt line.
  function drawFrame(): void {
    if (!FANCY) {
      rl.prompt();
      frameUp = true;
      return;
    }
    const w = frameWidth();
    const label = acronym(); // "Mas ADE" (7 visible), A/D/E each coloured
    const top = dim("╭─ ") + label + " " + dim("─".repeat(Math.max(1, w - 9)) + "╮");
    const bot = dim("╰" + "─".repeat(w) + "╯");
    process.stdout.write(top + "\n");
    rl.setPrompt(dim("│") + "  " + cyan("❯ "));
    rl.prompt();
    process.stdout.write("\x1b7\n" + bot + "\x1b8"); // save cursor, drop, draw bottom, restore
    frameUp = true;
  }

  // Print something while the frame is up without corrupting it: clear the
  // prompt line + top rule, render, wipe the stale bottom rule, redraw.
  function emitAboveFrame(render: () => void): void {
    if (!FANCY) {
      render();
      rl.prompt();
      return;
    }
    process.stdout.write("\r\x1b[K\x1b[1A\r\x1b[K");
    render();
    process.stdout.write("\x1b[0J");
    drawFrame();
  }

  // After Enter the cursor sits on the bottom-rule row; wipe all three frame
  // rows so the prompt doesn't stack on redraw.
  const clearFrame = () => process.stdout.write("\r\x1b[K\x1b[1A\r\x1b[K\x1b[1A\r\x1b[K");

  let backToPrompt: NodeJS.Timeout | undefined;
  const armPrompt = () => {
    if (backToPrompt) clearTimeout(backToPrompt);
    backToPrompt = setTimeout(() => {
      stopSpinner();
      rl.resume();
      if (FANCY) console.log();
      drawFrame();
    }, 2500);
  };

  void (async () => {
    try {
      for await (const line of streamReplies(true, ac.signal)) {
        if (line === CLI_READY) continue;
        if (frameUp) {
          emitAboveFrame(() => printReply(line));
        } else {
          stopSpinner();
          printReply(line);
          startSpinner();
          armPrompt();
        }
      }
    } catch (e) {
      stopSpinner();
      if (!ac.signal.aborted) console.error(red("stream putus: " + (e instanceof Error ? e.message : String(e))));
    }
  })();

  drawFrame();
  rl.on("line", async (line) => {
    if (FANCY) clearFrame();
    frameUp = false;
    const t = line.trim();
    if (!t) {
      drawFrame();
      return;
    }
    if (FANCY) console.log(dim("❯ ") + t);
    rl.pause();
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
