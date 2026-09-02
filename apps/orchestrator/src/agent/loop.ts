import { auditLog, providerUsageRepo } from "../db/index.js";
import { config } from "../config.js";
import {
  TOOL_SCHEMAS,
  executeTool,
  briefToolDescription,
  detectMilestone,
  isDangerousBashCommand,
  isWriteBashCommand,
} from "./tools.js";
import { scanStagedFiles, formatSecretHits } from "./secretScan.js";
import { runProjectChecks, type CommitCheckSpec } from "./projectChecks.js";
import { markRateLimited } from "./providerCooldown.js";
import { resolveFigmaTools, type FigmaToolsResult } from "./mcp/figmaTools.js";
import type { ChatMessage, Provider, ToolSchema } from "./types.js";
import { ProviderError } from "./types.js";

export interface RunAgentLoopParams {
  providers: Provider[];
  systemPrompt: string;
  instruction: string;
  cwd: string;
  taskId: string;
  abortController: AbortController;
  // Awaited at every call site — progress/checkpoint messages must actually
  // finish sending (or fail) in the order they're raised, or WhatsApp can
  // deliver them out of order (e.g. a "fase beres" notice arriving after the
  // next phase's "start" notice, since two fire-and-forget sends race).
  onProgress: (text: string) => Promise<void>;
  maxTurns?: number;
  // Extra system messages injected right after the main system prompt —
  // currently the RAG "relevant existing code" block (see agent/rag). Kept as
  // a plain string list so this file never has to know what produced them;
  // an empty list (the default) leaves the loop exactly as it was.
  extraSystemNotes?: string[];
  // DI seam for tests — real callers never pass this. Detects a Figma link
  // in the instruction and, if the account is linked, connects to Figma's
  // MCP server and returns its read-only tools.
  resolveFigmaToolsFn?: (instruction: string, taskId: string) => Promise<FigmaToolsResult>;
  // Backs the send_document tool — real value only known at the router/handler
  // level (needs the WhatsApp recipient), so it's threaded down as a callback
  // rather than looked up here. Defaults to a stub so existing callers/tests
  // that don't care about this tool don't need to pass it.
  sendDocument?: (relPath: string, caption: string | undefined) => Promise<string>;
  // Called before running a `bash` command that isDangerousBashCommand flags,
  // to ask the user on WhatsApp and wait for their reply. Defaults to
  // auto-deny (fail closed) so a caller that forgets to wire this doesn't
  // silently downgrade to "run it anyway".
  onDangerousBash?: (command: string, reason: string) => Promise<boolean>;
  // DI seam for tests — real callers never pass this, production always waits
  // the full RATE_LIMIT_RETRY_DELAY_MS between same-provider retries on a 429.
  rateLimitRetryDelayMs?: number;
  // The project's test/lint commands, run right before a `git commit` — a
  // failure blocks the commit (same hard-gate shape as the secret scan).
  // Undefined/empty means no gate. See agent/projectChecks.ts.
  commitChecks?: CommitCheckSpec;
  // Read-only mode for the "tanya:" repo Q&A: only `bash` + `read_file` are
  // offered, and a `bash` command that isWriteBashCommand is refused. The
  // model can grep/read to answer, but not modify/commit/install.
  readOnly?: boolean;
}

export interface RunAgentLoopResult {
  ok: boolean;
  summary: string;
  // Set only on failures the caller can reasonably ask the user to fix and
  // retry without losing pipeline progress (currently: Figma not linked yet).
  // pipeline.ts's checkpoint revise loop treats this as "still waiting for a
  // usable answer" instead of failing the whole task.
  recoverable?: boolean;
  // Set when the task ended because the user cancelled it (stop command or
  // checkpoint "batal"), as opposed to a genuine error — the caller
  // (router/handler.ts's executeTask) uses this to decide whether to discard
  // whatever the git work branch accumulated, since a cancelled task's
  // changes were never asked for in the first place.
  cancelled?: boolean;
}

// A 429 with a free-tier per-minute quota (the case that prompted this) is
// gone within seconds — worth waiting out on the same key rather than
// immediately burning through the fallback chain or, with only one provider
// configured, failing the whole task over something that would've cleared
// itself up.
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_RETRY_DELAY_MS = 10_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

const FIGMA_TOOLS_SYSTEM_NOTE =
  "You also have read-only Figma tools (names starting with figma_) for the Figma link(s) in the instruction — layers, styles, variables, generated code, images. Never expect a Figma tool to change/write/comment on anything; if a task needs that, say so in your final reply instead of trying.";

// A provider-agnostic ReAct loop: ask the current provider for the next step,
// execute any tool calls it requests locally, feed the results back, repeat
// until it answers with plain text (done) or every provider in the fallback
// chain has failed on the same turn.
export async function runAgentLoop(params: RunAgentLoopParams): Promise<RunAgentLoopResult> {
  const {
    providers,
    systemPrompt,
    instruction,
    cwd,
    taskId,
    abortController,
    onProgress,
    maxTurns = 40,
    extraSystemNotes = [],
    resolveFigmaToolsFn = resolveFigmaTools,
    sendDocument = async () => "Fitur kirim dokumen belum tersedia di sini.",
    onDangerousBash = async () => false,
    rateLimitRetryDelayMs = RATE_LIMIT_RETRY_DELAY_MS,
    commitChecks,
    readOnly = false,
  } = params;

  if (providers.length === 0) {
    return { ok: false, summary: "Belum ada AI provider yang diatur, jadi aku belum bisa kerja." };
  }

  const figmaTools = await resolveFigmaToolsFn(instruction, taskId);
  if (figmaTools.kind === "not_linked") {
    // Not recoverable — "hubungkan figma" currently always declines (see
    // handler.ts's handleConnectFigmaCommand), so pausing to wait for it to
    // get resolved would just hang. Fail with a clear, accurate explanation
    // instead of pointing at a command that can't actually help right now.
    return {
      ok: false,
      summary:
        "Ada link Figma di instruksi, tapi integrasi Figma lagi gak bisa dipakai (Figma sendiri yang batesin aksesnya, bukan soal koneksi). Coba kirim ulang instruksinya tanpa link Figma-nya, atau kirim gambar/screenshot desainnya kalau ada.",
    };
  }
  if (figmaTools.kind === "error") {
    return { ok: false, summary: `Gagal konek ke Figma: ${figmaTools.message}` };
  }

  const baseSchemas: ToolSchema[] = readOnly
    ? TOOL_SCHEMAS.filter((t) => t.name === "bash" || t.name === "read_file")
    : TOOL_SCHEMAS;
  const toolSchemas: ToolSchema[] =
    figmaTools.kind === "ready" ? [...baseSchemas, ...figmaTools.schemas] : baseSchemas;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...extraSystemNotes.filter((note) => note.trim() !== "").map((note) => ({ role: "system" as const, content: note })),
    ...(figmaTools.kind === "ready" ? [{ role: "system" as const, content: FIGMA_TOOLS_SYSTEM_NOTE }] : []),
    { role: "user", content: instruction },
  ];

  try {
    let providerIndex = 0;
    let rateLimitRetries = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortController.signal.aborted) {
        return { ok: false, cancelled: true, summary: "Oke, task-nya udah aku batalin." };
      }

      const provider = providers[providerIndex];
      let response;
      try {
        response = await provider.chat(messages, toolSchemas, abortController.signal);
        rateLimitRetries = 0;
        providerUsageRepo.bump(provider.id ?? provider.name);
      } catch (err) {
        if (abortController.signal.aborted) {
          return { ok: false, cancelled: true, summary: "Oke, task-nya udah aku batalin." };
        }
        const message = err instanceof ProviderError ? err.message : String(err);
        auditLog.add(taskId, "error", message);

        if (err instanceof ProviderError && err.status === 429) {
          // Park this exact instance so the next buildProviders() (next
          // message/task) starts past it instead of re-hitting an exhausted
          // key/model.
          markRateLimited(provider.id ?? provider.name);
        }

        if (err instanceof ProviderError && err.status === 429 && rateLimitRetries < RATE_LIMIT_MAX_RETRIES) {
          rateLimitRetries++;
          auditLog.add(
            taskId,
            "note",
            `Rate limited on ${provider.name}, retry ${rateLimitRetries}/${RATE_LIMIT_MAX_RETRIES} in ${rateLimitRetryDelayMs / 1000}s`
          );
          await onProgress(`"${provider.name}" lagi kena limit, nunggu bentar terus coba lagi ya.`);
          await sleep(rateLimitRetryDelayMs, abortController.signal);
          if (abortController.signal.aborted) {
            return { ok: false, cancelled: true, summary: "Oke, task-nya udah aku batalin." };
          }
          turn--; // doesn't consume a turn from the budget
          continue;
        }

        if (providerIndex + 1 < providers.length) {
          rateLimitRetries = 0;
          const failed = provider;
          providerIndex++;
          const next = providers[providerIndex];
          // Same name, different model back-to-back means runner.ts's Gemini
          // fallback-model expansion kicked in on the same key — distinct
          // from a same-name/same-model pair (a different API key) and from
          // an actual provider switch, each of which reads misleadingly as
          // the other two if worded the same.
          const progressText =
            failed.name === next.name
              ? failed.model && next.model && failed.model !== next.model
                ? `Model "${failed.model}" lagi kena limit, aku coba model lain: "${next.model}".`
                : `API key "${failed.name}" yang ini lagi bermasalah (mungkin abis kuotanya), aku coba API key lain buat provider yang sama.`
              : `"${failed.name}" lagi bermasalah, aku coba pindah ke "${next.name}" ya.`;
          await onProgress(progressText);
          auditLog.add(taskId, "note", `Fallback: ${failed.name}${failed.model ? `/${failed.model}` : ""} -> ${next.name}${next.model ? `/${next.model}` : ""} (${message})`);
          turn--; // doesn't consume a turn from the budget
          continue;
        }
        return { ok: false, summary: `Semua opsi AI lagi gak bisa dipakai. Error terakhirnya: ${message}` };
      }

      if (response.type === "text") {
        return { ok: true, summary: response.text || "Beres, tapi aku lupa kasih ringkasan." };
      }

      messages.push({ role: "assistant", content: response.text, toolCalls: response.calls });

      for (const call of response.calls) {
        auditLog.add(taskId, "tool_use", briefToolDescription(call.name, call.input));
        const milestone = detectMilestone(call.name, call.input);
        if (milestone) await onProgress(milestone);

        if (readOnly && (call.name === "write_file" || call.name === "edit_file" || call.name === "send_document")) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: "Error: sesi ini read-only (cuma buat jawab pertanyaan soal kode). Gak bisa nulis/ngedit/ngirim file.",
          });
          continue;
        }

        if (call.name === "bash") {
          const command = String(call.input.command ?? "");
          const isCommit = /\bgit\s+commit\b/.test(command);

          if (readOnly && isWriteBashCommand(command)) {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              toolName: call.name,
              content:
                "Error: sesi ini read-only. Command itu keliatan mau ngubah sesuatu (commit/install/hapus/tulis). Pakai command baca aja — grep/rg/find/cat/git log/git show/git diff.",
            });
            continue;
          }

          // Hard stop before the agent commits a leaked credential — no
          // WhatsApp override, unlike the risky-command gate below. The model
          // has to actually remove the secret (or explain it's a false
          // positive in its summary) instead of retrying the commit as-is.
          if (config.secretScan.enabled && isCommit) {
            const hits = scanStagedFiles(cwd, command);
            if (hits.length > 0) {
              auditLog.add(taskId, "note", `Commit diblok — kredensial kedetect: ${hits.map((h) => `${h.file}:${h.line}`).join(", ")}`);
              messages.push({
                role: "tool",
                toolCallId: call.id,
                toolName: call.name,
                content:
                  `Error: commit dibatalin. Ada yang kelihatan seperti kredensial di file yang mau di-commit:\n${formatSecretHits(hits)}\n\n` +
                  "Keluarin nilainya dari file (pakai env var atau placeholder). Kalau ini beneran bukan secret, jangan commit apa adanya — jelasin di ringkasan akhir aja.",
              });
              continue;
            }
          }

          // Same hard-gate shape: the project's test/lint command has to pass
          // before a commit lands, so a red suite never reaches the default
          // branch on the autonomy-full path. Runs on every commit attempt in
          // a phase, like the secret scan above.
          if (config.commitChecks.enabled && isCommit && commitChecks) {
            const checked = await runProjectChecks(cwd, commitChecks, abortController.signal);
            if (checked && !checked.ok) {
              auditLog.add(taskId, "note", "Commit diblok — cek test/lint project gagal");
              messages.push({
                role: "tool",
                toolCallId: call.id,
                toolName: call.name,
                content:
                  `Error: commit dibatalin. ${checked.report}\n\n` +
                  "Benerin dulu yang bikin gagal, terus commit lagi — jangan cari cara buat ngeskip cek ini.",
              });
              continue;
            }
          }

          const dangerReason = isDangerousBashCommand(command);
          if (dangerReason) {
            auditLog.add(taskId, "note", `Nunggu konfirmasi WhatsApp buat command berisiko (${dangerReason})`);
            const approved = await onDangerousBash(command, dangerReason);
            if (abortController.signal.aborted) {
              return { ok: false, cancelled: true, summary: "Oke, task-nya udah aku batalin." };
            }
            if (!approved) {
              auditLog.add(taskId, "note", "Command berisiko gak disetujui, dilewatin.");
              messages.push({
                role: "tool",
                toolCallId: call.id,
                toolName: call.name,
                content:
                  "Error: command ini butuh persetujuan user lewat WhatsApp dan tidak disetujui. Jangan diulang persis sama — coba pendekatan lain, atau jelaskan di ringkasan akhir kenapa ini diperlukan.",
              });
              continue;
            }
          }
        }

        const result =
          figmaTools.kind === "ready" && call.name.startsWith("figma_")
            ? await figmaTools.call(call.name.slice("figma_".length), call.input)
            : call.name === "send_document"
              ? await sendDocument(String(call.input.path ?? ""), typeof call.input.caption === "string" ? call.input.caption : undefined)
              : await executeTool(call.name, call.input, cwd);
        messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: result });
      }
    }

    return { ok: false, summary: "Aku hentiin task ini — kepanjangan langkahnya dan gak kunjung selesai." };
  } finally {
    if (figmaTools.kind === "ready") {
      await figmaTools.close().catch(() => {});
    }
  }
}
