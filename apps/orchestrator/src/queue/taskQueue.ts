// Tasks targeting the same project run strictly one-after-another (so the agent
// never has two concurrent sessions writing to the same git workspace). Tasks
// for different projects run fully in parallel.

interface ActiveTask {
  taskId: string;
  abortController: AbortController;
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
