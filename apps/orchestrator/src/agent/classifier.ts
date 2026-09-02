import { DEPARTMENT_KEYS, DEPARTMENT_LABELS, type DepartmentKey } from "./departments.js";
import { runClassifier, type LocalClassifyOpts } from "./localClassifier.js";
import type { Provider } from "./types.js";

export interface ClassifiedPhase {
  department: DepartmentKey | "semua";
  note: string;
}

const DEPARTMENT_LINE_RE = new RegExp(`^\\s*(${DEPARTMENT_KEYS.join("|")})\\s*:\\s*(.+)$`, "i");

function buildClassifierPrompt(instruction: string): string {
  const departmentList = DEPARTMENT_KEYS.map((key) => `${key} — ${DEPARTMENT_LABELS[key]}`).join("\n");
  return `Decide which of these departments actually need to work on the task below, and in what order. Most tasks only need 1-3 departments — don't list ones that aren't genuinely relevant.

Departments:
${departmentList}

If the task is building a whole new application/feature from scratch, use manajemen, desain, dev, and qa, in that order — desain must come before dev so the UI/UX is worked out before writing code — plus infra and/or bisnis too if genuinely relevant. For smaller or narrower requests (a fix, a tweak, adding one small thing to something that already exists), only pick the departments that specific request actually needs — don't force the full sequence onto something small.

Reply with one line per relevant department, in the order they should work, exactly in this format:
<department-key>: <one short sentence on what that department will do for this task>

Use only the exact keys listed above. Don't add anything else — no intro, no summary, no markdown.

Task: "${instruction}"`;
}

// Line-by-line, forgiving on purpose — free-tier models don't always follow
// formatting instructions exactly, and a failed parse should degrade to the
// old single-phase behavior rather than block the task.
function parseClassifierResponse(text: string): ClassifiedPhase[] {
  const phases: ClassifiedPhase[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(DEPARTMENT_LINE_RE);
    if (!match) continue;
    const department = match[1].toLowerCase() as DepartmentKey;
    if (seen.has(department)) continue;
    seen.add(department);
    phases.push({ department, note: match[2].trim() });
  }
  return phases;
}

const FALLBACK = (instruction: string): ClassifiedPhase[] => [{ department: "semua", note: instruction }];

export async function classifyDepartments(
  instruction: string,
  provider: Provider,
  signal: AbortSignal,
  opts?: LocalClassifyOpts
): Promise<ClassifiedPhase[]> {
  return runClassifier({
    prompt: buildClassifierPrompt(instruction),
    provider,
    signal,
    parse: (text) => {
      const phases = parseClassifierResponse(text);
      return phases.length > 0 ? { value: phases } : undefined;
    },
    fallback: FALLBACK(instruction),
    opts,
  });
}
