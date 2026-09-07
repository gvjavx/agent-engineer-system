import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocSpec, parseSlides, renderDocument, generateDocument, toCellValue } from "./documentGen.js";
import type { Provider, ProviderResponse } from "./types.js";

const sig = () => new AbortController().signal;
const decode = (b64: string) => Buffer.from(b64, "base64");
const isZip = (b64: string) => decode(b64).subarray(0, 2).toString("latin1") === "PK";

const reply = (format: string, filename: string, body: string) => `FORMAT: ${format}\nFILENAME: ${filename}\n---\n${body}`;

test("parseDocSpec reads the header block and takes everything after --- as the body", () => {
  const spec = parseDocSpec(reply("md", "catatan.md", "# Halo\n\nbaris dua\nbaris tiga"));
  assert.deepEqual(spec, { format: "md", filename: "catatan.md", content: "# Halo\n\nbaris dua\nbaris tiga" });
});

test("parseDocSpec keeps literal newlines in the body (the JSON-escaping failure mode)", () => {
  const body = "# Proposal\n\n## Latar belakang\n\nKalimat panjang.\n\n## Anggaran\n\n- item satu\n- item dua";
  assert.equal(parseDocSpec(reply("pdf", "proposal.pdf", body))?.content, body);
});

test("parseDocSpec strips a wrapping code fence", () => {
  const spec = parseDocSpec("```\n" + reply("txt", "x.txt", "isi") + "\n```");
  assert.equal(spec?.format, "txt");
  assert.equal(spec?.content, "isi");
});

test("parseDocSpec forces the extension to match the format", () => {
  assert.equal(parseDocSpec(reply("pdf", "laporan", "isi"))?.filename, "laporan.pdf");
});

test("parseDocSpec sanitizes a filename with a path and odd characters but keeps accented letters", () => {
  assert.equal(parseDocSpec(reply("csv", "../etc/da ta*.csv", "a,b"))?.filename, "da ta.csv");
  assert.equal(parseDocSpec(reply("pdf", "Ringkasan Rapat Café.pdf", "isi"))?.filename, "Ringkasan Rapat Café.pdf");
});

test("parseDocSpec rejects an unknown format, a missing divider, or empty body", () => {
  assert.equal(parseDocSpec(reply("rtf", "x", "y")), undefined);
  assert.equal(parseDocSpec("FORMAT: md\nFILENAME: x.md\n(no divider here)"), undefined);
  assert.equal(parseDocSpec(reply("md", "x.md", "   ")), undefined);
});

test("parseSlides splits on headings and collects bullets with indent levels", () => {
  const slides = parseSlides("# Intro\n- poin satu\n  - sub poin\n    - sub sub\n---\n# Penutup\n- terima kasih");
  assert.deepEqual(slides, [
    {
      title: "Intro",
      bullets: [
        { text: "poin satu", level: 0 },
        { text: "sub poin", level: 1 },
        { text: "sub sub", level: 2 },
      ],
    },
    { title: "Penutup", bullets: [{ text: "terima kasih", level: 0 }] },
  ]);
});

test("toCellValue coerces only plain integers/decimals, leaving everything else as text", () => {
  assert.equal(toCellValue("30"), 30);
  assert.equal(toCellValue("4.5"), 4.5);
  assert.equal(toCellValue("-12"), -12);
  assert.equal(toCellValue(" 7 "), 7);
  assert.equal(toCellValue("Andi"), "Andi");
  assert.equal(toCellValue("1,000"), "1,000");
  assert.equal(toCellValue("Rp 5000"), "Rp 5000");
  assert.equal(toCellValue("007"), "007");
  assert.equal(toCellValue("2026-01-01"), "2026-01-01");
  assert.equal(toCellValue(""), "");
});

test("renderDocument passes markdown/text/csv straight through as bytes", async () => {
  for (const format of ["md", "txt", "csv"] as const) {
    const r = await renderDocument({ format, filename: `f.${format}`, content: "isi\nbaris dua" });
    assert.equal(decode(r.base64).toString("utf8"), "isi\nbaris dua");
    assert.equal(r.filename, `f.${format}`);
  }
});

test("renderDocument builds a pdf via the injected renderer, which gets the raw markdown", async () => {
  let gotMd = "";
  const r = await renderDocument(
    { format: "pdf", filename: "r.pdf", content: "# Judul\n\nisi paragraf" },
    {
      pdfRenderer: async (md) => {
        gotMd = md;
        return Buffer.from("%PDF-1.4 fake");
      },
    }
  );
  assert.equal(gotMd, "# Judul\n\nisi paragraf");
  assert.equal(r.mimeType, "application/pdf");
  assert.equal(decode(r.base64).toString("utf8"), "%PDF-1.4 fake");
});

test("renderDocument produces a real PDF through the default (browserless) renderer", async () => {
  const r = await renderDocument({
    format: "pdf",
    filename: "real.pdf",
    content: "# Proposal\n\nParagraf **tebal** dan _miring_.\n\n- poin satu\n- poin dua\n\n| A | B |\n|---|---|\n| 1 | 2 |",
  });
  assert.equal(decode(r.base64).subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(decode(r.base64).length > 1000);
});

test("renderDocument produces real Office containers for docx/xlsx/pptx", async () => {
  const docx = await renderDocument({ format: "docx", filename: "d.docx", content: "# Judul\n\nisi" });
  assert.ok(isZip(docx.base64), "docx should be a zip container");

  const xlsx = await renderDocument({ format: "xlsx", filename: "s.xlsx", content: "nama,umur\nAndi,30\nBudi,25" });
  assert.ok(isZip(xlsx.base64), "xlsx should be a zip container");

  const pptx = await renderDocument({ format: "pptx", filename: "p.pptx", content: "# Slide 1\n- poin" });
  assert.ok(isZip(pptx.base64), "pptx should be a zip container");
});

test("renderDocument throws for xlsx when the body has no CSV rows", async () => {
  await assert.rejects(renderDocument({ format: "xlsx", filename: "s.xlsx", content: "   \n \n" }));
});

function providerReturning(text: string): Provider {
  return { name: "fake", chat: async () => ({ type: "text", text }) satisfies ProviderResponse };
}

test("generateDocument: model reply -> rendered doc", async () => {
  const result = await generateDocument(
    "bikinin ringkasan",
    [providerReturning(reply("md", "ringkasan.md", "# Ringkasan\n\nselesai"))],
    sig()
  );
  assert.ok(result.ok);
  assert.equal(result.doc.filename, "ringkasan.md");
  assert.equal(decode(result.doc.base64).toString("utf8"), "# Ringkasan\n\nselesai");
});

test("generateDocument walks past a failing/unusable provider to a working one", async () => {
  const throwing: Provider = {
    name: "cooled",
    chat: async () => {
      throw new Error("429");
    },
  };
  const garbage = providerReturning("no divider, no format");
  const working = providerReturning(reply("txt", "ok.txt", "jadi"));
  const result = await generateDocument("x", [throwing, garbage, working], sig());
  assert.ok(result.ok);
  assert.equal(decode(result.doc.base64).toString("utf8"), "jadi");
});

test("generateDocument reports why it failed when every provider reply is unusable", async () => {
  const toolCalls: Provider = { name: "aa", chat: async () => ({ type: "tool_calls", calls: [] }) };
  const res = await generateDocument("x", [toolCalls, providerReturning("nope")], sig());
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /aa: balasan bukan teks/);
});

test("generateDocument reports a render failure with the format and message", async () => {
  const res = await generateDocument("bikin pdf", [providerReturning(reply("pdf", "x.pdf", "isi"))], sig(), {
    pdfRenderer: async () => {
      throw new Error("no chromium here");
    },
  });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /render pdf: no chromium here/);
});
