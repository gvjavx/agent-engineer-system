// This codebase is otherwise mostly reactive (runs in response to an inbound
// webhook). This is one of two background setInterval loops in the same
// long-running orchestrator process — the other is the scheduled-task runner
// (router/handler.ts's startScheduleRunner). Single replica (see
// infra/docker-compose.yml), so no distributed-lock concern.
import { config } from "../config.js";
import { conversationRepo } from "../db/index.js";
import { sendWhatsApp } from "../whatsappClient.js";
import { cancelActiveTask, getActiveTaskId } from "../queue/taskQueue.js";
import { hasPendingCheckpoint } from "../agent/checkpoint.js";
import { hasPendingBashApproval } from "../agent/bashApproval.js";

const SCAN_INTERVAL_MS = 60_000;

export async function scanIdleSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - config.sessionIdleMinutes * 60_000).toISOString();

  for (const state of conversationRepo.listIdleUnnotifiedSessions(cutoff)) {
    const sessionId = state.current_session_id!; // guaranteed non-null by the query
    let taskCancelledNote = "";

    if (state.active_project_alias) {
      const taskId = getActiveTaskId(state.active_project_alias);
      // Only cancel when the task is actually stuck waiting on this user —
      // last_message_at only updates on inbound messages, so a legitimate
      // checkpoint-free ("Ya, langsung") run can easily take 30+ minutes on
      // its own with zero required input. Killing that just because the
      // user's been quiet would discard real in-progress work for no reason.
      if (taskId && (hasPendingCheckpoint(taskId) || hasPendingBashApproval(taskId))) {
        cancelActiveTask(state.active_project_alias);
        conversationRepo.setPendingAction(state.from_number, null);
        taskCancelledNote = " Ada yang masih nunggu jawaban kamu tadi, udah aku batalin otomatis biar gak nyangkut.";
      }
    }

    await sendWhatsApp(
      state.from_number,
      `Sesi kita yang tadi udah aku anggap selesai (udah ${config.sessionIdleMinutes} menit gak ada balesan) dan obrolannya udah kesimpen.${taskCancelledNote} Kalau mau lanjut, tinggal chat lagi kapan aja.`
    );
    conversationRepo.markSessionNotified(state.from_number, sessionId);
  }
}

export function startIdleSessionScanner(): void {
  setInterval(() => {
    scanIdleSessions().catch((err) => console.error("Idle session scan failed:", err));
  }, SCAN_INTERVAL_MS);
}
