import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { auditLog } from "../db/index.js";

export interface RunTaskParams {
  taskId: string;
  cwd: string;
  projectAlias: string;
  defaultBranch: string;
  workBranch: string;
  autoMerge: "direct" | "pr";
  instruction: string;
  abortController: AbortController;
  onProgress: (text: string) => void;
}

export interface RunTaskResult {
  ok: boolean;
  summary: string;
  totalCostUsd?: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

function briefToolDescription(block: ContentBlock): string {
  if (block.type !== "tool_use" || !block.name) return "";
  const input = block.input as Record<string, unknown> | undefined;
  if (block.name === "Bash" && typeof input?.command === "string") {
    const cmd = input.command as string;
    return `🔧 ${cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd}`;
  }
  if ((block.name === "Edit" || block.name === "Write") && typeof input?.file_path === "string") {
    return `✏️ ${block.name === "Write" ? "Menulis" : "Mengedit"} ${input.file_path}`;
  }
  if (block.name === "Read" && typeof input?.file_path === "string") {
    return `📖 Membaca ${input.file_path}`;
  }
  return `⚙️ ${block.name}`;
}

// Only a handful of milestone bash commands get pushed to WhatsApp as progress
// updates — everything else just goes to the audit log, to avoid spamming the user.
const MILESTONE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+commit\b/, label: "📝 Commit dibuat" },
  { pattern: /\bgit\s+push\b/, label: "⬆️ Push ke remote" },
  { pattern: /\bgh\s+pr\s+create\b/, label: "🔀 Pull request dibuat" },
  { pattern: /\bgh\s+pr\s+merge\b/, label: "✅ Pull request di-merge" },
  { pattern: /\bgit\s+merge\b/, label: "✅ Branch di-merge" },
  {
    pattern: /\b(npm|pnpm|yarn)\s+(test|run\s+test|run\s+build|run\s+lint)\b|\bpytest\b|\bgo\s+test\b/,
    label: "🧪 Menjalankan test/build",
  },
];

function detectMilestone(command: string): string | undefined {
  for (const { pattern, label } of MILESTONE_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return undefined;
}

export async function runTask(params: RunTaskParams): Promise<RunTaskResult> {
  const {
    taskId,
    cwd,
    projectAlias,
    defaultBranch,
    workBranch,
    autoMerge,
    instruction,
    abortController,
    onProgress,
  } = params;

  const systemPrompt = buildSystemPrompt({
    projectAlias,
    defaultBranch,
    workBranch,
    autoMerge,
  });

  const stream = query({
    prompt: instruction,
    options: {
      cwd,
      abortController,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt,
      model: config.claudeModel,
      env: { ...process.env, ANTHROPIC_API_KEY: config.anthropicApiKey },
    },
  });

  let finalSummary = "";
  let ok = false;
  let totalCostUsd: number | undefined;

  try {
    for await (const message of stream) {
      if (message.type === "assistant") {
        const content = (message.message?.content ?? []) as ContentBlock[];
        for (const block of content) {
          if (block.type === "tool_use") {
            const desc = briefToolDescription(block);
            if (desc) {
              auditLog.add(taskId, "tool_use", desc);
            }
            if (block.name === "Bash") {
              const input = block.input as Record<string, unknown> | undefined;
              const command = typeof input?.command === "string" ? input.command : "";
              const milestone = detectMilestone(command);
              if (milestone) onProgress(milestone);
            }
          }
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          finalSummary = message.result;
          ok = !message.is_error;
        } else {
          finalSummary = `Task berhenti dengan error (${message.subtype}).`;
          ok = false;
        }
        totalCostUsd = (message as { total_cost_usd?: number }).total_cost_usd;
      }
    }
  } catch (err) {
    auditLog.add(taskId, "error", String(err));
    return {
      ok: false,
      summary: `Terjadi error saat menjalankan agent: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!finalSummary) {
    finalSummary = "Task selesai tanpa ringkasan dari agent.";
  }

  return { ok, summary: finalSummary, totalCostUsd };
}
