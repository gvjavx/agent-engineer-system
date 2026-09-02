import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxEnv, buildBwrapArgs, bashInvocation } from "./sandbox.js";

// Default mode ("auto") — the tests don't set AGENT_SANDBOX, so env scrubbing
// is on and bwrap is inactive on a non-Linux CI/dev box.

test("sandboxEnv drops vendor and internal secrets", () => {
  const scrubbed = sandboxEnv({
    PATH: "/usr/bin",
    HOME: "/home/agent",
    GEMINI_API_KEY: "secret1",
    META_ACCESS_TOKEN: "secret2",
    META_APP_SECRET: "secret3",
    INTERNAL_SHARED_SECRET: "secret4",
    OPENROUTER_API_KEY: "secret5",
    QWEN_API_KEY: "secret6",
    DB_PATH: "/data/x.sqlite",
  });
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.HOME, "/home/agent");
  for (const gone of [
    "GEMINI_API_KEY",
    "META_ACCESS_TOKEN",
    "META_APP_SECRET",
    "INTERNAL_SHARED_SECRET",
    "OPENROUTER_API_KEY",
    "QWEN_API_KEY",
    "DB_PATH",
  ]) {
    assert.equal(scrubbed[gone], undefined, `${gone} should be scrubbed`);
  }
});

test("sandboxEnv keeps the allowlist, LC_* locale vars, and GITHUB_TOKEN", () => {
  const scrubbed = sandboxEnv({
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy:8080",
    LC_ALL: "en_US.UTF-8",
    LC_TIME: "id_ID.UTF-8",
    GITHUB_TOKEN: "gh-token-kept-on-purpose",
    NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  });
  assert.equal(scrubbed.HTTPS_PROXY, "http://proxy:8080");
  assert.equal(scrubbed.LC_ALL, "en_US.UTF-8");
  assert.equal(scrubbed.LC_TIME, "id_ID.UTF-8");
  assert.equal(scrubbed.GITHUB_TOKEN, "gh-token-kept-on-purpose");
  assert.equal(scrubbed.NODE_EXTRA_CA_CERTS, "/etc/ca.pem");
});

test("buildBwrapArgs mounts read-only root before the tmpfs overlays and binds the workspace last", () => {
  const args = buildBwrapArgs("/ws/proj", "npm test", ["/app", "/app/data"]);
  const roBind = args.indexOf("--ro-bind");
  const firstTmpfs = args.indexOf("--tmpfs");
  const bind = args.indexOf("--bind");
  const dashdash = args.indexOf("--");

  assert.ok(roBind !== -1 && firstTmpfs !== -1 && bind !== -1 && dashdash !== -1);
  assert.ok(roBind < firstTmpfs, "ro-bind / must come before any tmpfs");
  assert.ok(firstTmpfs < bind, "hidden-path tmpfs must come before the workspace bind");
  assert.ok(bind < dashdash, "the workspace bind must come before the command");

  // Each hidden path gets its own tmpfs entry.
  assert.ok(args.join(" ").includes("--tmpfs /app "));
  assert.ok(args.join(" ").includes("--tmpfs /app/data "));

  // Workspace is bound rw and is the working directory; command is last.
  assert.deepEqual(args.slice(bind, bind + 5), ["--bind", "/ws/proj", "/ws/proj", "--chdir", "/ws/proj"]);
  assert.equal(args[args.length - 2], "-c");
  assert.equal(args[args.length - 1], "npm test");
});

test("bashInvocation without bwrap runs bash -c directly with a scrubbed env", () => {
  const inv = bashInvocation("/ws/proj", "echo hi");
  assert.deepEqual(inv.args, ["-c", "echo hi"]);
  assert.match(inv.file, /bash/);
  // Scrub is applied to the real process env — a vendor key never rides along.
  assert.equal(inv.env.GEMINI_API_KEY, undefined);
  assert.equal(inv.env.INTERNAL_SHARED_SECRET, undefined);
});
