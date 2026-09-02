// Splits a source file for embedding. First choice: symbol-aware — cut at
// top-level (and one level of nested) function/class/type boundaries so a
// chunk is a coherent unit instead of an arbitrary 60-line slice. It's
// heuristic (regex per language family, no tree-sitter), so anything it
// can't parse — or a file with too little structure to matter — falls back
// to the plain overlapping line windows, which is also what unknown
// languages get.

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

// Lines that start a symbol. Deliberately loose — a false split just makes a
// slightly odd chunk, and the model re-reads with read_file anyway. Up to a
// few spaces of indent so class methods count, not just top-level.
const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /^\s{0,3}(export\s+)?(default\s+)?(declare\s+)?(async\s+)?function\*?\s+[A-Za-z_$]/,
    /^\s{0,3}(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?class\s+[A-Za-z_$]/,
    /^\s{0,3}(export\s+)?(declare\s+)?(interface|enum|namespace|module)\s+[A-Za-z_$]/,
    /^\s{0,3}(export\s+)?type\s+[A-Za-z_$][\w$]*\s*(<[^=]*>)?\s*=/,
    /^\s{0,3}(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(:[^=]+)?=>/,
  ],
  py: [/^(\s{0,4})(async\s+)?def\s+[A-Za-z_]/, /^(\s{0,4})class\s+[A-Za-z_]/],
  go: [/^func\s+(\([^)]*\)\s*)?[A-Za-z_]/, /^type\s+[A-Za-z_]\w*\s+(struct|interface)\b/],
  rs: [
    /^\s{0,4}(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+[A-Za-z_]/,
    /^\s{0,4}(pub(\([^)]*\))?\s+)?(struct|enum|trait|impl|mod)\s+[A-Za-z_<]/,
  ],
  rb: [/^\s{0,4}(def|class|module)\s+[A-Za-z_]/],
  php: [
    /^\s{0,4}(abstract\s+|final\s+)?(public\s+|private\s+|protected\s+|static\s+)*(function|class|interface|trait)\s+[A-Za-z_]/,
  ],
  jvm: [
    /^\s{0,4}(@[\w.]+\s+)?(public\s+|private\s+|protected\s+|internal\s+|open\s+|final\s+|static\s+|abstract\s+|sealed\s+|data\s+)*(class|interface|enum|object|struct|record|protocol|extension|trait)\s+[A-Za-z_]/,
    /^\s{2,6}(@[\w.]+\s+)?(public\s+|private\s+|protected\s+|internal\s+|open\s+|final\s+|static\s+|override\s+|suspend\s+|async\s+)*(fun|func|void|def)\s+[A-Za-z_]/,
  ],
};

const EXT_FAMILY: Record<string, keyof typeof SYMBOL_PATTERNS> = {
  ".ts": "js", ".tsx": "js", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".vue": "js", ".svelte": "js", ".astro": "js",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
  ".rb": "rb",
  ".php": "php",
  ".java": "jvm", ".kt": "jvm", ".kts": "jvm", ".cs": "jvm", ".scala": "jvm", ".swift": "jvm",
};

type Range = [start1: number, end1: number]; // 1-indexed, inclusive

function windowRanges(total: number, windowLines: number, overlap: number): Range[] {
  const step = Math.max(1, windowLines - overlap);
  const out: Range[] = [];
  for (let start = 0; start < total; start += step) {
    const end = Math.min(start + windowLines, total);
    out.push([start + 1, end]);
    if (end === total) break;
  }
  return out;
}

// undefined -> caller uses windowRanges instead.
function symbolRanges(filePath: string, lines: string[], windowLines: number, overlap: number): Range[] | undefined {
  const dot = filePath.lastIndexOf(".");
  const family = dot > 0 ? EXT_FAMILY[filePath.slice(dot).toLowerCase()] : undefined;
  if (!family) return undefined;
  const patterns = SYMBOL_PATTERNS[family];

  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) boundaries.push(i);
  }
  // Too little structure to beat a plain window.
  if (boundaries.length < 2) return undefined;

  // Half-open [start0, end0) blocks: an optional header, then one per symbol.
  const raw: Array<[number, number]> = [];
  if (boundaries[0] > 0) raw.push([0, boundaries[0]]);
  for (let k = 0; k < boundaries.length; k++) {
    raw.push([boundaries[k], k + 1 < boundaries.length ? boundaries[k + 1] : lines.length]);
  }

  // Glue adjacent small blocks together up to windowLines; window any single
  // block bigger than 1.5x that.
  const big = Math.ceil(windowLines * 1.5);
  const out: Range[] = [];
  let cur: [number, number] | null = null;
  const flush = (): void => {
    if (!cur) return;
    const span = cur[1] - cur[0];
    if (span > big) {
      for (const [s, e] of windowRanges(span, windowLines, overlap)) out.push([cur[0] + s, cur[0] + e]);
    } else {
      out.push([cur[0] + 1, cur[1]]);
    }
    cur = null;
  };
  for (const b of raw) {
    if (cur && b[1] - cur[0] <= windowLines) cur[1] = b[1];
    else {
      flush();
      cur = [b[0], b[1]];
    }
  }
  flush();
  return out;
}

export function chunkFile(
  filePath: string,
  source: string,
  opts: { lines?: number; overlap?: number } = {}
): FileChunk[] {
  const windowLines = Math.max(1, Math.floor(opts.lines ?? DEFAULT_LINES));
  const overlap = Math.min(Math.max(0, Math.floor(opts.overlap ?? DEFAULT_OVERLAP)), windowLines - 1);

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  // A file that ends in a newline splits into a trailing "" — drop it so a
  // 60-line file doesn't report as ending on line 61.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.every((l) => l.trim() === "")) return [];

  const ranges =
    symbolRanges(filePath, lines, windowLines, overlap) ?? windowRanges(lines.length, windowLines, overlap);

  const chunks: FileChunk[] = [];
  for (const [start1, end1] of ranges) {
    const body = lines.slice(start1 - 1, end1).join("\n");
    if (body.trim() === "") continue;
    chunks.push({
      filePath,
      startLine: start1,
      endLine: end1,
      content: `// ${filePath}:${start1}-${end1}\n${body}`,
    });
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
