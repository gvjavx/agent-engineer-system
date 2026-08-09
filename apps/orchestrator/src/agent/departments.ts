export const DEPARTMENT_KEYS = ["manajemen", "dev", "desain", "qa", "infra", "bisnis"] as const;
export type DepartmentKey = (typeof DEPARTMENT_KEYS)[number];

// "semua" isn't a real department — it means "one general phase, same as the
// old single-loop behavior" and is what classification falls back to when it
// can't confidently pick specific departments.
export type DepartmentOrAll = DepartmentKey | "semua";

export const DEPARTMENT_LABELS: Record<DepartmentKey, string> = {
  manajemen: "Manajemen Proyek & Produk",
  dev: "Tim Pengembangan",
  desain: "Tim Desain",
  qa: "QA & Testing",
  infra: "Infrastruktur & Operasional",
  bisnis: "Tim Bisnis & Pendukung",
};

const ALIASES: Record<DepartmentKey, string[]> = {
  manajemen: ["manajemen", "produk", "product", "pm", "project", "management"],
  dev: ["dev", "pengembangan", "development", "developer", "engineering", "engineer"],
  desain: ["desain", "design", "ui", "ux", "ui/ux"],
  qa: ["qa", "testing", "test", "quality"],
  infra: ["infra", "infrastruktur", "infrastructure", "ops", "operasional", "devops", "deployment"],
  bisnis: ["bisnis", "business", "support", "pendukung"],
};

const ALIAS_TO_KEY: Record<string, DepartmentKey> = Object.fromEntries(
  DEPARTMENT_KEYS.flatMap((key) => ALIASES[key].map((alias) => [alias, key]))
);

const ALL_ALIASES = new Set(["semua", "all", "default", "umum"]);

export function normalizeDepartment(input: string): DepartmentOrAll | undefined {
  const key = input.trim().toLowerCase();
  if (ALL_ALIASES.has(key)) return "semua";
  return ALIAS_TO_KEY[key];
}
