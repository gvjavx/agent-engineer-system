import type { Task } from "../db/index.js";

// Tasks targeting the same project run strictly one-after-another (so the agent
// never has two concurrent sessions writing to the same git workspace). Tasks
// for different projects run fully in parallel.

interface ActiveTask {
  taskId: string;
  abortController: AbortController;
}

// A task re-run this many times by a restart and still not finished is
// treated as stuck (a genuine bug, an un-clonable repo, ...) and abandoned
// rather than resumed again — otherwise a crash loop replays it forever.
export const MAX_RESUME_ATTEMPTS = 2;

// Split the tasks left mid-flight at startup into ones worth re-running and
// ones to give up on. Order preserved (oldest first) so resumed tasks keep
// their original queue position ahead of anything that comes in after boot.
export function planResume(interrupted: Task[]): { resume: Task[]; abandon: Task[] } {
  const resume: Task[] = [];
  const abandon: Task[] = [];
  for (const task of [...interrupted].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    // No phases_json means the row predates persist/resume — it can't be
    // reconstructed, so it's abandoned with a clear message.
    if (!task.phases_json || task.resume_count >= MAX_RESUME_ATTEMPTS) {
      abandon.push(task);
    } else {
      resume.push(task);
    }
  }
  return { resume, abandon };
}

const projectChains = new Map<string, Promise<void>>();
const activeTaskByProject = new Map<string, ActiveTask>();

export function enqueueProjectTask(
  projectAlias: string,
  taskId: string,
  run: (abortController: AbortController) => Promise<void>
): void {
  const previous = projectChains.get(projectAlias) ?? Promise.resolve();
  const abortController = new AbortController();

  const next = previous
    .then(async () => {
      activeTaskByProject.set(projectAlias, { taskId, abortController });
      try {
        await run(abortController);
      } finally {
        const current = activeTaskByProject.get(projectAlias);
        if (current?.taskId === taskId) {
          activeTaskByProject.delete(projectAlias);
        }
      }
    })
    .catch((err) => {
      console.error(`Unhandled error running task ${taskId} for ${projectAlias}:`, err);
    });

  projectChains.set(projectAlias, next);
}

export function cancelActiveTask(projectAlias: string): string | undefined {
  const active = activeTaskByProject.get(projectAlias);
  if (!active) return undefined;
  active.abortController.abort();
  return active.taskId;
}

export function getActiveTaskId(projectAlias: string): string | undefined {
  return activeTaskByProject.get(projectAlias)?.taskId;
}
