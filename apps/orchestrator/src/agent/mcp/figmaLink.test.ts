import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFigmaFileRefs } from "./figmaLink.js";

test("extractFigmaFileRefs returns nothing when there's no Figma link", () => {
  assert.deepEqual(extractFigmaFileRefs("tambahin endpoint health check"), []);
});

test("extractFigmaFileRefs handles a /file/ link without a node-id", () => {
  const refs = extractFigmaFileRefs("bikin dari https://www.figma.com/file/abc123XYZ/My-Design");
  assert.deepEqual(refs, [
    { url: "https://www.figma.com/file/abc123XYZ/My-Design", fileKey: "abc123XYZ", nodeId: undefined },
  ]);
});

test("extractFigmaFileRefs handles a /design/ link with a node-id query param", () => {
  const refs = extractFigmaFileRefs(
    "cek frame ini ya https://figma.com/design/abc123/My-File?node-id=12%3A34&t=xyz buat komponennya"
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].fileKey, "abc123");
  assert.equal(refs[0].nodeId, "12:34");
});

test("extractFigmaFileRefs handles multiple links in one instruction", () => {
  const refs = extractFigmaFileRefs(
    "bandingin https://figma.com/design/aaa/One dan https://figma.com/proto/bbb/Two?node-id=1-2"
  );
  assert.equal(refs.length, 2);
  assert.equal(refs[0].fileKey, "aaa");
  assert.equal(refs[1].fileKey, "bbb");
  assert.equal(refs[1].nodeId, "1-2");
});
