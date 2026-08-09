// In-memory registry that lets a paused pipeline (waiting mid-task for a
// checkpoint review reply) be resumed by a later WhatsApp message handled on
// a completely different call stack. Same spirit as mcp/figmaOAuthState.ts —
// short-lived, tied to a task that's alive in this same process, no need for
// DB persistence.

export type CheckpointResolution =
  | { action: "continue" }
  | { action: "revise"; instruction: string }
  | { action: "cancel" };

interface PendingCheckpoint {
  resolve: (resolution: CheckpointResolution) => void;
  onAbort: () => void;
  signal: AbortSignal;
}

const pending = new Map<string, PendingCheckpoint>();

export function waitForCheckpoint(taskId: string, abortSignal: AbortSignal): Promise<CheckpointResolution> {
  return new Promise((resolve) => {
    const onAbort = () => {
      pending.delete(taskId);
      resolve({ action: "cancel" });
    };
    pending.set(taskId, { resolve, onAbort, signal: abortSignal });
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveCheckpoint(taskId: string, resolution: CheckpointResolution): boolean {
  const entry = pending.get(taskId);
  if (!entry) return false;
  pending.delete(taskId);
  entry.signal.removeEventListener("abort", entry.onAbort);
  entry.resolve(resolution);
  return true;
}

export function hasPendingCheckpoint(taskId: string): boolean {
  return pending.has(taskId);
}
