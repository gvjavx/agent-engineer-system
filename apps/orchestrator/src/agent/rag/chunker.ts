// Splits a source file into overlapping line windows for embedding. No
// language parsing — a fixed line window is good enough to get the right
// region of a file in front of the model, and it works the same for every
// language without pulling in tree-sitter.

export interface FileChunk {
  filePath: string;
  startLine: number; // 1-indexed, inclusive
  endLine: number; // 1-indexed, inclusive
  // The text that actually gets embedded and stored. Prefixed with a
  // "// <path>:<lines>" line so the path is part of the vector and shows up
  // in whatever the model is handed back.
  content: string;
}

const DEFAULT_LINES = 60;
const DEFAULT_OVERLAP = 10;

export function chunkFile(
  filePath: string,
  source: string,
  opts: { lines?: number; overlap?: number } = {}
): FileChunk[] {
  const windowLines = Math.max(1, Math.floor(opts.lines ?? DEFAULT_LINES));
  const overlap = Math.min(Math.max(0, Math.floor(opts.overlap ?? DEFAULT_OVERLAP)), windowLines - 1);
  const step = windowLines - overlap;

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  // A file that ends in a newline splits into a trailing "" — drop it so a
  // 60-line file doesn't report as ending on line 61.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  if (lines.every((l) => l.trim() === "")) return [];

  const chunks: FileChunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + windowLines, lines.length);
    const body = lines.slice(start, end).join("\n");
    if (body.trim() !== "") {
      chunks.push({
        filePath,
        startLine: start + 1,
        endLine: end,
        content: `// ${filePath}:${start + 1}-${end}\n${body}`,
      });
    }
    if (end === lines.length) break;
  }
  return chunks;
}

const INDEXABLE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".scala", ".m", ".mm",
  ".sh", ".bash", ".sql", ".css", ".scss", ".sass", ".less", ".html", ".vue", ".svelte",
  ".astro", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".md", ".mdx", ".txt",
  ".gradle", ".proto", ".graphql", ".prisma", ".tf",
]);

const INDEXABLE_BASENAME = new Set(["Dockerfile", "Makefile", "Rakefile", "Gemfile", ".env.example"]);

// Lockfiles and checksum manifests: huge, churn constantly, and carry no
// context worth retrieving. The .lock/.lockb ones are already caught by
// extension below — these are the .json/.yaml/.sum ones that aren't.
const SKIP_BASENAME = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "go.sum",
]);

// Belt and braces: `git ls-files` already skips most of these, but a
// kind='local' folder has no git to lean on.
const SKIP_DIR =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|__pycache__|\.venv|venv|target|\.next|\.nuxt|\.svelte-kit|\.cache|\.git)(\/|$)/;

const MAX_FILE_BYTES = 256 * 1024;

export function shouldIndexFile(relPath: string, sizeBytes: number): boolean {
  const posix = relPath.split(/[\\/]/).join("/");
  if (SKIP_DIR.test(posix)) return false;
  if (sizeBytes > MAX_FILE_BYTES) return false;

  const base = posix.split("/").pop() ?? posix;
  if (/\.min\.(js|css)$/i.test(base)) return false;
  if (/\.(lock|lockb|map)$/i.test(base)) return false;
  if (SKIP_BASENAME.has(base)) return false;
  if (INDEXABLE_BASENAME.has(base)) return true;

  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return INDEXABLE_EXT.has(base.slice(dot).toLowerCase());
}
