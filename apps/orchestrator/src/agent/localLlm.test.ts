import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsableLocalReply } from "./localLlm.js";

const SYS = "Kamu asisten. Jawab singkat, Bahasa Indonesia. Kalau nggak yakin bilang nggak tau.";

test("isUsableLocalReply keeps a real answer", () => {
  assert.equal(isUsableLocalReply("Ibukota Jepang adalah Tokyo.", SYS, "apa ibukota jepang"), true);
  assert.equal(isUsableLocalReply("Wah nggak tau nih, maaf.", SYS, "berapa penduduk mars"), true);
});

test("isUsableLocalReply rejects a system-prompt echo", () => {
  assert.equal(isUsableLocalReply("Kamu asisten. Jawab singkat, Bahasa Indonesia.", SYS, "apa ibukota jepang"), false);
});

test("isUsableLocalReply rejects a bare question echo", () => {
  assert.equal(isUsableLocalReply("apa ibukota jepang", SYS, "apa ibukota jepang"), false);
});

test("isUsableLocalReply rejects looping / degenerate output", () => {
  assert.equal(
    isUsableLocalReply(
      "tambah 3 berapa? tambah 3 berapa? tambah 3 berapa? tambah 3 berapa?",
      SYS,
      "2 tambah 3 berapa"
    ),
    false
  );
  assert.equal(isUsableLocalReply("halo.\nhalo.\nhalo.\nhalo.", SYS, "apa kabar"), false);
  assert.equal(isUsableLocalReply("", SYS, "x"), false);
});
