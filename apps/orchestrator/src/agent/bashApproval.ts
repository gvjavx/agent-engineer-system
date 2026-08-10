// In-memory registry so a bash tool call paused mid-task waiting for WhatsApp
// approval can be resolved by a later message handled on a different call
// stack. Same pattern as checkpoint.ts, but scoped to a single tool call
// instead of a whole pipeline phase.

interface PendingApproval {
  resolve: (approved: boolean) => void;
  onAbort: () => void;
  signal: AbortSignal;
}

const pending = new Map<string, PendingApproval>();

// Aborting (task cancelled/"stop") resolves as not-approved — a cancelled
// task shouldn't run the risky command just because nobody answered in time.
export function waitForBashApproval(taskId: string, abortSignal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const onAbort = () => {
      pending.delete(taskId);
      resolve(false);
    };
    pending.set(taskId, { resolve, onAbort, signal: abortSignal });
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveBashApproval(taskId: string, approved: boolean): boolean {
  const entry = pending.get(taskId);
  if (!entry) return false;
  pending.delete(taskId);
  entry.signal.removeEventListener("abort", entry.onAbort);
  entry.resolve(approved);
  return true;
}

export function hasPendingBashApproval(taskId: string): boolean {
  return pending.has(taskId);
}
