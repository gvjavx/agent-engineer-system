import { execFile } from "node:child_process";

// "deploy" — push the active project to Vercel via its CLI (npx). Token-gated:
// nothing happens without VERCEL_TOKEN in .env (same "built, needs config"
// stance as the Figma integration). Vercel's zero-config detection covers
// most framework repos; anything it can't build reports the CLI's own error.

const DEPLOY_TIMEOUT_MS = 8 * 60_000;

// The deployment URL Vercel prints on success — only a *.vercel.app host
// counts (the CLI also prints an "Inspect: https://vercel.com/…" dashboard
// link, which must NOT be mistaken for a live deploy on a failed build).
export function extractDeployUrl(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9-]+\.vercel\.app[^\s"'()]*/i)?.[0];
}

// Post-deploy smoke test: does the URL actually respond? Best-effort, bounded.
export async function smokeCheck(url: string, timeoutMs = 20_000): Promise<{ ok: boolean; detail: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

export async function deployToVercel(
  cwd: string,
  token: string,
  signal: AbortSignal
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--yes", "vercel@latest", "--prod", "--yes", "--token", token],
      { cwd, timeout: DEPLOY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        const url = extractDeployUrl(`${stdout}\n${stderr}`);
        // Trust the exit code: a non-zero exit is a failed build/deploy even
        // if the CLI already echoed a *.vercel.app URL for a prior deploy.
        if (!err && url) return resolve({ ok: true, url });
        const msg = (stderr || (err && err.message) || "").trim().split("\n").slice(-3).join(" ");
        resolve({
          ok: false,
          error: msg || (url ? "deploy gagal (exit non-zero)" : "deploy jalan tapi URL-nya nggak kebaca dari output"),
        });
      }
    );
  });
}
