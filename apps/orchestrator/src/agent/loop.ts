import { auditLog } from "../db/index.js";
import { TOOL_SCHEMAS, executeTool, briefToolDescription, detectMilestone } from "./tools.js";
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
  onProgress: (text: string) => void;
  maxTurns?: number;
  // DI seam for tests — real callers never pass this. Detects a Figma link
  // in the instruction and, if the account is linked, connects to Figma's
  // MCP server and returns its read-only tools.
  resolveFigmaToolsFn?: (instruction: string, taskId: string) => Promise<FigmaToolsResult>;
  // Backs the send_document tool — real value only known at the router/handler
  // level (needs the WhatsApp recipient), so it's threaded down as a callback
  // rather than looked up here. Defaults to a stub so existing callers/tests
  // that don't care about this tool don't need to pass it.
  sendDocument?: (relPath: string, caption: string | undefined) => Promise<string>;
}

export interface RunAgentLoopResult {
  ok: boolean;
  summary: string;
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
    resolveFigmaToolsFn = resolveFigmaTools,
    sendDocument = async () => "Fitur kirim dokumen belum tersedia di sini.",
  } = params;

  if (providers.length === 0) {
    return { ok: false, summary: "Belum ada AI provider yang diatur, jadi aku belum bisa kerja." };
  }

  const figmaTools = await resolveFigmaToolsFn(instruction, taskId);
  if (figmaTools.kind === "not_linked") {
    return {
      ok: false,
      summary:
        'Ada link Figma di instruksi, tapi akun Figma belum kesambung. Ketik "hubungkan figma" dulu ya, terus kirim ulang instruksinya.',
    };
  }
  if (figmaTools.kind === "error") {
    return { ok: false, summary: `Gagal konek ke Figma: ${figmaTools.message}` };
  }

  const toolSchemas: ToolSchema[] = figmaTools.kind === "ready" ? [...TOOL_SCHEMAS, ...figmaTools.schemas] : TOOL_SCHEMAS;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(figmaTools.kind === "ready" ? [{ role: "system" as const, content: FIGMA_TOOLS_SYSTEM_NOTE }] : []),
    { role: "user", content: instruction },
  ];

  try {
    let providerIndex = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortController.signal.aborted) {
        return { ok: false, summary: "Oke, task-nya udah aku batalin." };
      }

      const provider = providers[providerIndex];
      let response;
      try {
        response = await provider.chat(messages, toolSchemas, abortController.signal);
      } catch (err) {
        if (abortController.signal.aborted) {
          return { ok: false, summary: "Oke, task-nya udah aku batalin." };
        }
        const message = err instanceof ProviderError ? err.message : String(err);
        auditLog.add(taskId, "error", message);

        if (providerIndex + 1 < providers.length) {
          const failedName = provider.name;
          providerIndex++;
          const nextName = providers[providerIndex].name;
          // Same name back-to-back means it's a different API key of the
          // same provider (see runner.ts's multi-key expansion), not an
          // actual provider switch — say so, "pindah ke gemini" after
          // failing on "gemini" reads like nothing changed.
          onProgress(
            failedName === nextName
              ? `API key "${failedName}" yang ini lagi bermasalah (mungkin abis kuotanya), aku coba API key lain buat provider yang sama.`
              : `"${failedName}" lagi bermasalah, aku coba pindah ke "${nextName}" ya.`
          );
          auditLog.add(taskId, "note", `Fallback: ${failedName} -> ${nextName} (${message})`);
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
        if (milestone) onProgress(milestone);

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
