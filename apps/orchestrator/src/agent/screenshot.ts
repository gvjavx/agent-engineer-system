import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

// "screenshot" command: bring up the active project's dev/preview server, load
// it in a headless Chromium, send back a PNG. Chromium is the brotli-packed
// @sparticuz build (unpacks to /tmp on first launch) so the image only grows
// by ~60MB. Everything here is best-effort and bounded — a failure just means
// no picture, and the dev server is always killed.

const DEV_SERVER_READY_MS = 60_000;
const NAV_TIMEOUT_MS = 30_000;

// package.json scripts that start a viewable server, in the order to prefer.
const DEV_SCRIPT_PREFERENCE = ["dev", "preview", "start", "serve"];

export interface DevCommand {
  runner: "npm" | "pnpm" | "yarn";
  script: string;
}

export function detectDevCommand(cwd: string): DevCommand | undefined {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (pkg?.scripts && typeof pkg.scripts === "object") scripts = pkg.scripts as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const script = DEV_SCRIPT_PREFERENCE.find((s) => typeof scripts[s] === "string");
  if (!script) return undefined;
  const runner = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(cwd, "yarn.lock"))
      ? "yarn"
      : "npm";
  return { runner, script };
}

// First localhost URL a dev server prints when it's up. 0.0.0.0 is normalised
// to 127.0.0.1 so Chromium (same network namespace) can actually reach it.
export function extractLocalUrl(output: string): string | undefined {
  const m = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i);
  return m ? m[0].replace("0.0.0.0", "127.0.0.1").replace("localhost", "127.0.0.1") : undefined;
}

export interface Preview {
  url: string;
  stop: () => void;
}

// Spawns the dev command, waits for it to announce a localhost URL, and hands
// back that URL plus a killer for the whole process group. Rejects (never
// leaves a process running) on early exit or timeout.
export function startPreview(cwd: string, cmd: DevCommand): Promise<Preview> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.runner, ["run", cmd.script], {
      cwd,
      detached: true, // own process group, so stop() can kill vite/next children too
      env: { ...process.env, BROWSER: "none", CI: "1", FORCE_COLOR: "0" },
    });

    let out = "";
    let settled = false;
    const stop = () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3000).unref();
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const onData = (buf: Buffer) => {
      out += buf.toString();
      const url = extractLocalUrl(out);
      if (url) finish(() => setTimeout(() => resolve({ url, stop }), 1500));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => finish(() => { stop(); reject(err); }));
    child.on("exit", (code) =>
      finish(() => reject(new Error(`dev server langsung mati (exit ${code}): ${out.trim().split("\n").slice(-3).join(" ")}`)))
    );

    const timer = setTimeout(
      () => finish(() => { stop(); reject(new Error(`dev server gak siap dalam ${DEV_SERVER_READY_MS / 1000} detik`)); }),
      DEV_SERVER_READY_MS
    );
  });
}

const INSTALL_TIMEOUT_MS = 5 * 60_000;

export function hasNodeModules(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "node_modules"));
}

// A freshly cloned workspace has no node_modules — the dev server won't start
// without them. Bounded; reports the tail of stderr on failure.
export function installDeps(cwd: string, runner: DevCommand["runner"]): Promise<{ ok: boolean; error?: string }> {
  const args = runner === "yarn" ? ["install"] : ["install", "--no-audit", "--no-fund"];
  return new Promise((resolve) => {
    execFile(runner, args, { cwd, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      resolve(
        err ? { ok: false, error: (stderr || err.message).trim().split("\n").slice(-3).join(" ") } : { ok: true }
      );
    });
  });
}

export async function screenshotUrl(
  url: string
): Promise<{ ok: true; pngBase64: string } | { ok: false; error: string }> {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    } catch {
      // one retry — a just-started dev server sometimes drops the first hit
      await new Promise((r) => setTimeout(r, 2000));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    }
    const png = await page.screenshot({ fullPage: true, type: "png" });
    return { ok: true, pngBase64: Buffer.from(png).toString("base64") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await browser?.close().catch(() => {});
  }
}
