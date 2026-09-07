import { marked } from "marked";
import HTMLtoDOCX from "html-to-docx";
import ExcelJS from "exceljs";
import pptxgen from "pptxgenjs";
import { markdownToPdf } from "./markdownPdf.js";
import type { Provider } from "./types.js";

// "buatkan dokumen ..." / "bikinin laporan dalam pdf" — a one-shot: ask the
// model for the document's content + a format, then render the bytes here.
// Nothing touches disk and every renderer is pure JS (no headless browser),
// so this works with no project registered and on any host.

export type DocFormat = "pdf" | "docx" | "md" | "txt" | "csv" | "xlsx" | "pptx";

const FORMATS: DocFormat[] = ["pdf", "docx", "md", "txt", "csv", "xlsx", "pptx"];

const MIME: Record<DocFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export interface DocSpec {
  format: DocFormat;
  filename: string;
  // Markdown for pdf/docx/md/txt; CSV text for csv/xlsx; slide markdown
  // ("# Slide title" per slide, "- " bullets) for pptx.
  content: string;
}

export interface RenderedDoc {
  filename: string;
  mimeType: string;
  base64: string;
}

// Header lines then a "---" divider then the raw document body — not JSON.
// These models routinely put literal newlines inside a JSON string value,
// which is invalid JSON and makes JSON.parse throw on the common multi-line
// case; a divided plain-text reply has nothing to escape.
function buildPrompt(request: string): string {
  return `The user asked you to create a document/file, not code. Produce it in full.

Pick the format. If the user named one (pdf, word/docx, excel/xlsx, powerpoint/pptx, csv, markdown, txt), use that. Otherwise: a report / proposal / letter / notes → pdf; a data table or list of records → xlsx; a slide deck / presentation → pptx.

Content rules by format:
- pdf, docx, md, txt: the body is Markdown (headings, lists, tables, bold — no images).
- csv, xlsx: the body is CSV text, first row = column headers.
- pptx: the body is Markdown where every slide starts with "# Slide title" followed by "- bullet" lines.

Write real, complete, publish-ready content — as long as the document genuinely needs to be. Do not abbreviate it or leave placeholders. Write in Indonesian unless the request is clearly in another language.

Reply in exactly this shape and nothing else — three header lines, a line with only ---, then the document body verbatim:
FORMAT: <one of: ${FORMATS.join(", ")}>
FILENAME: <name with the matching extension, no folders>
---
<the document body>

Request: "${request}"`;
}

const HEADER_RE = /^\s*([A-Za-z]+)\s*:\s*(.*)$/;

// Strip an optional wrapping code fence, read the FORMAT/FILENAME headers,
// take everything after the first line that is just "---" as the body.
// Returns undefined on anything it can't trust.
export function parseDocSpec(raw: string): DocSpec | undefined {
  let text = raw.trim();
  const fence = text.match(/^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) text = fence[1].trim();

  const lines = text.split(/\r?\n/);
  const divider = lines.findIndex((l) => l.trim() === "---");
  if (divider === -1) return undefined;

  const headers: Record<string, string> = {};
  for (const line of lines.slice(0, divider)) {
    const m = line.match(HEADER_RE);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }

  const content = lines.slice(divider + 1).join("\n").trim();
  if (content === "") return undefined;

  const format = headers.format?.toLowerCase();
  if (!format || !FORMATS.includes(format as DocFormat)) return undefined;

  const fmt = format as DocFormat;
  return { format: fmt, filename: sanitizeFilename(headers.filename ?? "", fmt), content };
}

function sanitizeFilename(name: string, format: DocFormat): string {
  const basename = (name.split(/[/\\]/).pop() ?? "").replace(/[^\p{L}\p{N}._\- ]+/gu, "").trim();
  const stem = basename.replace(/\.[^.]*$/, "").replace(/^[.\s]+/, "").trim() || "dokumen";
  return `${stem}.${format}`;
}

export interface Slide {
  title: string;
  // `level` is the bullet's indent depth (0 = top level), from leading spaces
  // before the "-"/"*" — two spaces per level.
  bullets: { text: string; level: number }[];
}

// Split "# Title\n- a\n  - nested\n# Title2\n- c" into slides. Lines before the
// first heading, if any, seed a leading slide with no title.
export function parseSlides(md: string): Slide[] {
  const slides: Slide[] = [];
  let current: Slide | undefined;
  for (const rawLine of md.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trim() === "---") continue;
    const heading = rawLine.trim().match(/^#{1,3}\s+(.*)$/);
    if (heading) {
      current = { title: heading[1].trim(), bullets: [] };
      slides.push(current);
      continue;
    }
    const bullet = rawLine.match(/^(\s*)[-*]\s+(.*)$/);
    const text = (bullet ? bullet[2] : rawLine).trim();
    const level = bullet ? Math.min(Math.floor(bullet[1].length / 2), 4) : 0;
    if (!current) {
      current = { title: "", bullets: [] };
      slides.push(current);
    }
    current.bullets.push({ text, level });
  }
  return slides;
}

// A plain integer/decimal becomes a real number so xlsx cells sort and sum;
// anything with separators, currency, dates, or leading zeros stays text.
export function toCellValue(cell: string): string | number {
  const t = cell.trim();
  return t !== "" && !/^0\d/.test(t) && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : cell;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // handled by the \n
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function htmlDocument(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12pt;line-height:1.5;color:#111;margin:2.5cm}
h1,h2,h3{line-height:1.25;margin:1.2em 0 .5em}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px 8px;text-align:left}
code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f2f2f2;padding:1px 4px;border-radius:3px}
pre{background:#f2f2f2;padding:12px;border-radius:6px;overflow-x:auto}
</style></head><body>${bodyHtml}</body></html>`;
}

export interface RenderOpts {
  // Markdown -> PDF bytes. Defaults to agent/markdownPdf.ts (pure JS, no
  // browser). Injected in tests so they don't run the real renderer.
  pdfRenderer?: (markdown: string) => Promise<Buffer>;
}

export async function renderDocument(spec: DocSpec, opts: RenderOpts = {}): Promise<RenderedDoc> {
  const out = (buf: Buffer): RenderedDoc => ({
    filename: spec.filename,
    mimeType: MIME[spec.format],
    base64: buf.toString("base64"),
  });

  switch (spec.format) {
    case "md":
    case "txt":
    case "csv":
      return out(Buffer.from(spec.content, "utf8"));

    case "pdf": {
      const render = opts.pdfRenderer ?? markdownToPdf;
      return out(await render(spec.content));
    }

    case "docx": {
      const html = htmlDocument(await marked.parse(spec.content));
      const buf = (await HTMLtoDOCX(html, undefined, { footer: false, pageNumber: false })) as Buffer | ArrayBuffer;
      return out(Buffer.from(buf as ArrayBuffer));
    }

    case "xlsx": {
      const rows = parseCsv(spec.content);
      // The model didn't return usable CSV (e.g. it sent prose) — better to
      // fail loudly than hand back an empty or single-junk-column workbook.
      if (rows.length === 0) throw new Error("xlsx: model tidak mengembalikan CSV");
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet("Sheet1");
      // Header row stays text; body cells that are a plain integer/decimal
      // become real numbers so they sort and sum. Deliberately strict — no
      // thousands separators or dates, those are too ambiguous to guess.
      rows.forEach((row, i) => sheet.addRow(i === 0 ? row : row.map(toCellValue)));
      if (sheet.getRow(1).cellCount > 0) sheet.getRow(1).font = { bold: true };
      return out(Buffer.from(await wb.xlsx.writeBuffer()));
    }

    case "pptx": {
      const slides = parseSlides(spec.content);
      if (slides.length === 0) throw new Error("pptx: tidak ada slide yang terbaca");
      // pptxgenjs' d.ts types its default export as the `export as namespace`
      // object under NodeNext resolution, so `new pptxgen()` won't typecheck
      // even though it's the documented usage. Cast through the instance type.
      type Pptx = import("pptxgenjs").default;
      const pptx: Pptx = new (pptxgen as unknown as new () => Pptx)();
      for (const s of slides) {
        const slide = pptx.addSlide();
        if (s.title) slide.addText(s.title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true });
        if (s.bullets.length > 0) {
          slide.addText(
            s.bullets.map((b) => ({ text: b.text, options: { bullet: true, indentLevel: b.level } })),
            { x: 0.7, y: 1.3, w: 8.6, h: 5, fontSize: 18 }
          );
        }
      }
      return out((await pptx.write({ outputType: "nodebuffer" })) as Buffer);
    }
  }
}

export type GenerateDocResult = { ok: true; doc: RenderedDoc } | { ok: false; error: string };

// Walks the provider/key chain the same way generateImageFromPrompt and the
// agent loop do — a cooled-down or rate-limited providers[0] shouldn't sink
// the whole request when a healthy key sits behind it. On failure `error`
// carries the reason (bad model reply from every provider, or a render throw
// like "no Chromium for a pdf") so the caller can put it in the reply.
export async function generateDocument(
  request: string,
  providers: Provider[],
  signal: AbortSignal,
  opts: RenderOpts = {}
): Promise<GenerateDocResult> {
  const prompt = buildPrompt(request);
  const errors: string[] = [];
  for (const provider of providers) {
    let spec;
    try {
      const response = await provider.chat([{ role: "user", content: prompt }], [], signal);
      if (response.type !== "text") {
        errors.push(`${provider.name}: balasan bukan teks`);
        continue;
      }
      spec = parseDocSpec(response.text);
      if (!spec) {
        errors.push(`${provider.name}: format balasan gak kebaca`);
        continue;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[doc-gen] ${provider.name} failed:`, message);
      errors.push(`${provider.name}: ${message}`);
      continue;
    }

    try {
      return { ok: true, doc: await renderDocument(spec, opts) };
    } catch (err) {
      // The spec was fine; a render failure won't fix itself on another
      // provider, so stop here and report it.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[doc-gen] render ${spec.format} failed:`, message);
      return { ok: false, error: `render ${spec.format}: ${message}` };
    }
  }
  return {
    ok: false,
    error: (errors.length ? errors.join(" | ") : "gak ada provider AI yang aktif").slice(0, 600),
  };
}
