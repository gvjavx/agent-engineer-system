// Cheap, deterministic scan of a unified diff's added lines for the few things
// that are almost always left in by accident. Warn-only: the result is
// appended to the task-done WhatsApp message, it never blocks a commit (that's
// what agent/projectChecks.ts and agent/secretScan.ts are for). Patterns are
// deliberately narrow — no bare `console.log`, since plenty of code logs on
// purpose and a warning that fires on every task is one people learn to ignore.

const SMELLS: { re: RegExp; label: string }[] = [
  { re: /^\+.*\bdebugger\b\s*;?\s*$/m, label: "`debugger`" },
  { re: /^\+[^+].*\.only\s*\(/m, label: "`.only(` (test yang di-focus)" },
  { re: /^\+.*\b(fdescribe|fit)\s*\(/m, label: "`fdescribe`/`fit`" },
  { re: /^\+.*\bconsole\.(debug|trace)\s*\(/m, label: "`console.debug`/`console.trace`" },
];

export function scanDiffSmells(diff: string): string[] {
  return SMELLS.filter((s) => s.re.test(diff)).map((s) => s.label);
}
