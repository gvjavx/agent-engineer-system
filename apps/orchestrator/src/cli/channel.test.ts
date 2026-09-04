import assert from "node:assert/strict";
import { test } from "node:test";
import { attachCliListener, pushCliReply, recentCliBuffer, resetCliChannelForTests } from "./channel.js";

test("pushCliReply fans out to every attached listener and keeps a backlog", () => {
  resetCliChannelForTests();
  const a: string[] = [];
  const b: string[] = [];
  const detachA = attachCliListener((l) => a.push(l));
  attachCliListener((l) => b.push(l));

  pushCliReply("satu");
  pushCliReply("dua");
  detachA();
  pushCliReply("tiga");

  assert.deepEqual(a, ["satu", "dua"]);
  assert.deepEqual(b, ["satu", "dua", "tiga"]);
  assert.deepEqual(recentCliBuffer(), ["satu", "dua", "tiga"]);
});

test("pushCliReply survives a throwing listener", () => {
  resetCliChannelForTests();
  const seen: string[] = [];
  attachCliListener(() => {
    throw new Error("dead connection");
  });
  attachCliListener((l) => seen.push(l));
  pushCliReply("halo");
  assert.deepEqual(seen, ["halo"]);
});
