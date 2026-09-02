// Dump the chat knowledge base as a JSONL fine-tuning / distillation dataset:
// one {"messages":[{user},{assistant}]} per line. Only 'chat_model' rows —
// volatile, arithmetic, and answers the user later corrected are already gone.
//
//   npx tsx scripts/export-kb-dataset.ts [output-path]

import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { chatKbRepo } from "../src/db/chatKb.js";

const out = process.argv[2] ?? path.join(path.dirname(config.dbPath), "chat-kb-dataset.jsonl");

const rows = chatKbRepo.exportModelRows();
const lines = rows.map((r) =>
  JSON.stringify({
    messages: [
      { role: "user", content: r.question },
      { role: "assistant", content: r.answer },
    ],
  })
);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.length ? lines.join("\n") + "\n" : "");
console.log(`Wrote ${rows.length} Q&A pair(s) to ${out}`);
if (rows.length === 0) console.log("(nothing yet — the KB fills as people chat with CHAT_KB_ENABLED)");
process.exit(0);
