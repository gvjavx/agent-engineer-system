#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

const SELF = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")) as {
  name: string;
  version: string;
};

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
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const cyan = paint("36");
const magenta = paint("35");

// The wordmark: white "Mas (Ai Developer Engineer)" with the A / D / E — the
// initials of Ai · Developer · Engineer — in orange. Built with raw SGR so the
// bold+white base carries through and orange only swaps the foreground.
const _O = COLOR ? "\x1b[1;38;5;208m" : ""; // bold orange
const _W = COLOR ? "\x1b[1;97m" : ""; // bold bright-white
const _R = COLOR ? "\x1b[0m" : "";
const TITLE = `${_W}Mas (${_O}A${_W}i ${_O}D${_W}eveloper ${_O}E${_W}ngineer)${_R}`;
// Compact form for the input-frame label — same colours.
const acronym = (): string => `${_W}Mas ${_O}A${_O}D${_O}E${_R}`;

// ── intro ──────────────────────────────────────────────────────────────────

function intro(): void {
  console.log();
  console.log("  " + TITLE);
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

// ── self-update ────────────────────────────────────────────────────────────

const UPDATE_CACHE = path.join(os.homedir() || os.tmpdir(), ".mas-ade-update.json");
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function cmpVer(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Check npm for a newer version (throttled to every 6h) and, if there is one,
// `npm i -g` it and re-exec so the new version runs right away. Best-effort:
// offline, a failed install, or an npx invocation all just fall through.
async function maybeAutoUpdate(argv: string[]): Promise<void> {
  if (
    process.env.MAS_ADE_UPDATED === "1" ||
    process.env.MAS_ADE_NO_UPDATE === "1" ||
    process.env.CI ||
    argv.includes("--no-update") ||
    __dirname.includes("_npx") // npx already runs a fresh copy
  ) {
    return;
  }
  try {
    const c = JSON.parse(fs.readFileSync(UPDATE_CACHE, "utf8")) as { at: number };
    if (Date.now() - c.at < CHECK_EVERY_MS) return;
  } catch {
    /* no cache yet */
  }

  let latest: string | undefined;
  try {
    const res = await fetch(`https://registry.npmjs.org/${SELF.name}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) latest = ((await res.json()) as { version?: string }).version;
  } catch {
    return; // offline / slow — don't hold up the CLI
  }
  try {
    fs.writeFileSync(UPDATE_CACHE, JSON.stringify({ at: Date.now(), latest }));
  } catch {
    /* ignore */
  }
  if (!latest || cmpVer(latest, SELF.version) <= 0) return;

  process.stderr.write(dim(`\n  ${SELF.name} ${SELF.version} → ${latest}, update dulu…\n`));
  const r = spawnSync("npm", ["i", "-g", `${SELF.name}@latest`, "--no-audit", "--no-fund"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    process.stderr.write(
      yellow(`  auto-update gagal (mungkin butuh sudo). Manual: npm i -g ${SELF.name}@latest\n\n`)
    );
    return;
  }
  process.stderr.write(dim(`  ke ${latest}. Jalanin ulang…\n\n`));
  const again = spawnSync(process.execPath, [process.argv[1], ...argv], {
    stdio: "inherit",
    env: { ...process.env, MAS_ADE_UPDATED: "1" },
  });
  process.exit(again.status ?? 0);
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

interface SessionMeta {
  id: string;
  firstAt: string;
  lastAt: string;
  turns: number;
  preview: string;
}
interface Turn {
  role: "user" | "assistant";
  content: string;
}

async function getSessions(): Promise<SessionMeta[]> {
  try {
    const res = await fetch(`${BASE}/cli/sessions`, { headers: { "X-Internal-Secret": SECRET! } });
    if (!res.ok) return [];
    return ((await res.json()) as { sessions: SessionMeta[] }).sessions ?? [];
  } catch {
    return [];
  }
}

async function postSession(body: { action: "new" | "resume"; id?: string }): Promise<Turn[]> {
  try {
    const res = await fetch(`${BASE}/cli/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET! },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    return ((await res.json()) as { transcript?: Turn[] }).transcript ?? [];
  } catch {
    return [];
  }
}

function ago(iso: string): string {
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "barusan";
  if (m < 60) return `${Math.round(m)}m lalu`;
  if (m < 60 * 24) return `${Math.round(m / 60)}j lalu`;
  return `${Math.round(m / 1440)}h lalu`;
}

function printTranscript(rows: Turn[]): void {
  if (!rows.length) return;
  console.log(dim("  ┄ sesi sebelumnya ┄"));
  for (const r of rows.slice(-24)) {
    const who = r.role === "user" ? "kamu" : "ade ";
    console.log(dim(`  ${who} › ${r.content.split("\n")[0].slice(0, 100)}`));
  }
  console.log(dim("  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n"));
}

// Startup picker: continue a past conversation or start a new one.
async function pickSession(rl: readline.Interface): Promise<void> {
  const sessions = await getSessions();
  if (!sessions.length) {
    await postSession({ action: "new" });
    return;
  }
  console.log(dim("  Sesi sebelumnya:"));
  sessions.slice(0, 6).forEach((s, i) => {
    const prev = (s.preview || "(kosong)").replace(/\s+/g, " ").slice(0, 46);
    console.log(`  ${cyan(String(i + 1))}  ${dim(`${ago(s.lastAt)} · ${s.turns} pesan · ${prev}`)}`);
  });
  console.log(`  ${cyan("b")}  ${dim("mulai sesi baru")}`);
  const ans = (await new Promise<string>((r) => rl.question(`  pilih [${cyan("1")}]: `, r))).trim().toLowerCase();
  if (["b", "baru", "n", "new"].includes(ans)) {
    await postSession({ action: "new" });
    console.log(dim("  sesi baru.\n"));
    return;
  }
  const idx = ans === "" ? 0 : Number(ans) - 1;
  const s = sessions[Number.isInteger(idx) && idx >= 0 && idx < sessions.length ? idx : 0];
  console.log(dim(`  lanjutin sesi (${s.turns} pesan).\n`));
  printTranscript(await postSession({ action: "resume", id: s.id }));
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
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(SELF.version);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `${SELF.name} ${SELF.version}\n\n` +
        `  mas-ade                 REPL (pilih sesi lama / baru pas mulai)\n` +
        `  mas-ade "<instruksi>"   sekali jalan\n` +
        `  mas-ade --continue      lanjutin sesi terakhir, skip pilihan\n` +
        `  mas-ade --new           langsung sesi baru, skip pilihan\n` +
        `  mas-ade --wait=<detik>  jeda sepi buat one-shot (default 8)\n` +
        `  mas-ade --no-update     skip cek versi baru sekali ini\n\n` +
        `  env: INTERNAL_SHARED_SECRET (wajib), ORCHESTRATOR_URL (default http://localhost:4000)\n` +
        `       MAS_ADE_NO_UPDATE=1 buat matiin auto-update permanen, NO_COLOR=1 buat polos`
    );
    return;
  }

  await maybeAutoUpdate(args);

  if (!SECRET) {
    console.error(red("INTERNAL_SHARED_SECRET belum keset (di .env repo root atau di environment)."));
    process.exit(1);
  }

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

  // Register this before the first await below: with piped/closed stdin
  // readline fires "close" during the session picker, and anything that
  // touches rl afterwards (drawFrame's rl.prompt()) throws ERR_USE_AFTER_CLOSE.
  let closed = false;
  rl.on("close", () => {
    closed = true;
    quit(0);
  });

  // Session: continue a past one or start fresh.
  if (args.includes("--new")) {
    await postSession({ action: "new" });
  } else if (args.includes("--continue") || args.includes("-c")) {
    const [latest] = await getSessions();
    if (latest) printTranscript(await postSession({ action: "resume", id: latest.id }));
    else await postSession({ action: "new" });
  } else {
    await pickSession(rl);
  }

  const frameWidth = () => Math.min(Math.max((process.stdout.columns || 80) - 2, 24), 78);
  let frameUp = false;

  // Three-line input frame: top rule with the label, the prompt line
  // (readline owns it), a bottom rule. Cursor is left on the prompt line.
  function drawFrame(): void {
    if (closed) return;
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
