import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAddProject,
  parseAddFolder,
  parseDeleteProject,
  isValidAliasInput,
  parseUseProject,
  parseUseModel,
  parseListModelsForProvider,
  isListProjectsCommand,
  isListModelsCommand,
  isHelpCommand,
  isStatusCommand,
  isStopCommand,
  isConfirmYes,
  isConfirmNo,
  isConfirmYesWithCheckpoints,
  isIntroCommand,
  isConnectFigmaCommand,
  isGreetingCommand,
  isAllowedRepoUrl,
  extractGithubRepoUrl,
  isPlausibleShortCommand,
} from "./parse.js";

test("parseAddProject extracts alias and repo url", () => {
  const result = parseAddProject("tambah project toko-online https://github.com/x/toko-online.git");
  assert.deepEqual(result, {
    alias: "toko-online",
    repoUrl: "https://github.com/x/toko-online.git",
  });
});

test("parseAddProject is case-insensitive and tolerates surrounding whitespace", () => {
  const result = parseAddProject("  TAMBAH Project  demo   https://github.com/x/demo.git  ");
  assert.deepEqual(result, { alias: "demo", repoUrl: "https://github.com/x/demo.git" });
});

test("parseAddProject returns undefined for unrelated text", () => {
  assert.equal(parseAddProject("tambahin fitur login"), undefined);
  assert.equal(parseAddProject("tambah project cuma-satu-kata"), undefined);
});

test("parseDeleteProject extracts the alias", () => {
  assert.equal(parseDeleteProject("hapus project toko-online"), "toko-online");
  assert.equal(parseDeleteProject("  Hapus Project  demo  "), "demo");
  assert.equal(parseDeleteProject("hapuskan project demo"), "demo");
});

test("parseDeleteProject returns undefined for unrelated text", () => {
  assert.equal(parseDeleteProject("hapus project"), undefined);
  assert.equal(parseDeleteProject("hapus folder demo"), undefined);
  assert.equal(parseDeleteProject("tambah project demo https://github.com/x/demo.git"), undefined);
});

test("isValidAliasInput accepts a single word", () => {
  assert.ok(isValidAliasInput("toko-online"));
  assert.ok(isValidAliasInput("  toko_lama  "));
});

test("isValidAliasInput rejects empty, whitespace, and path-like input", () => {
  assert.ok(!isValidAliasInput(""));
  assert.ok(!isValidAliasInput("   "));
  assert.ok(!isValidAliasInput("toko online"));
  assert.ok(!isValidAliasInput("../evil"));
  assert.ok(!isValidAliasInput("a/b"));
  assert.ok(!isValidAliasInput("a\\b"));
});

test("isAllowedRepoUrl accepts plain https github.com repo URLs", () => {
  assert.ok(isAllowedRepoUrl("https://github.com/x/toko-online.git"));
  assert.ok(isAllowedRepoUrl("https://github.com/x/toko-online"));
  assert.ok(isAllowedRepoUrl("https://github.com/x/toko-online/"));
});

test("isAllowedRepoUrl rejects non-github hosts, non-https schemes, and git transport tricks", () => {
  assert.ok(!isAllowedRepoUrl("https://gitlab.com/x/y.git"));
  assert.ok(!isAllowedRepoUrl("http://github.com/x/y.git"));
  assert.ok(!isAllowedRepoUrl("git@github.com:x/y.git"));
  assert.ok(!isAllowedRepoUrl("ext::sh -c \"touch pwned\""));
  assert.ok(!isAllowedRepoUrl("file:///etc/passwd"));
  assert.ok(!isAllowedRepoUrl("https://github.com.evil.com/x/y.git"));
  assert.ok(!isAllowedRepoUrl("https://github.com/x/y --upload-pack=touch pwned"));
});

test("extractGithubRepoUrl finds and normalizes a plain repo URL", () => {
  assert.equal(extractGithubRepoUrl("https://github.com/facebook/react"), "https://github.com/facebook/react");
});

test("extractGithubRepoUrl strips a trailing .git suffix", () => {
  assert.equal(extractGithubRepoUrl("https://github.com/facebook/react.git"), "https://github.com/facebook/react");
});

test("extractGithubRepoUrl strips a trailing slash", () => {
  assert.equal(extractGithubRepoUrl("https://github.com/facebook/react/"), "https://github.com/facebook/react");
});

test("extractGithubRepoUrl ignores a trailing browser path (tree/branch, blob, query string)", () => {
  assert.equal(
    extractGithubRepoUrl("https://github.com/facebook/react/tree/main"),
    "https://github.com/facebook/react"
  );
  assert.equal(
    extractGithubRepoUrl("https://github.com/facebook/react/blob/main/README.md"),
    "https://github.com/facebook/react"
  );
  assert.equal(
    extractGithubRepoUrl("https://github.com/facebook/react?tab=readme-ov-file"),
    "https://github.com/facebook/react"
  );
});

test("extractGithubRepoUrl works without a protocol or with a www prefix", () => {
  assert.equal(extractGithubRepoUrl("github.com/facebook/react"), "https://github.com/facebook/react");
  assert.equal(extractGithubRepoUrl("www.github.com/facebook/react"), "https://github.com/facebook/react");
});

test("extractGithubRepoUrl finds the link even surrounded by other text", () => {
  assert.equal(
    extractGithubRepoUrl("ini reponya https://github.com/facebook/react ya, makasih"),
    "https://github.com/facebook/react"
  );
});

test("extractGithubRepoUrl returns undefined when there's no GitHub link at all", () => {
  assert.equal(extractGithubRepoUrl("gak ada link apa-apa di sini"), undefined);
  assert.equal(extractGithubRepoUrl("https://gitlab.com/facebook/react"), undefined);
});

test("isPlausibleShortCommand accepts short paraphrases", () => {
  assert.ok(isPlausibleShortCommand("gimana caranya pake ini", 12));
  assert.ok(isPlausibleShortCommand("bantuan", 12));
  assert.ok(isPlausibleShortCommand("udahan, stop dulu", 12));
});

test("isPlausibleShortCommand respects the word-count boundary", () => {
  const exactlyMax = "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas duabelas";
  assert.equal(exactlyMax.split(/\s+/).length, 12);
  assert.ok(isPlausibleShortCommand(exactlyMax, 12));
  assert.ok(!isPlausibleShortCommand(exactlyMax + " tigabelas", 12));
});

test("isPlausibleShortCommand rejects messages containing a URL regardless of word count", () => {
  assert.ok(!isPlausibleShortCommand("bikin komponen React dari desain ini: https://figma.com/design/abc", 12));
  assert.ok(!isPlausibleShortCommand("http://example.com", 12));
});

test("isPlausibleShortCommand rejects empty input", () => {
  assert.ok(!isPlausibleShortCommand("", 12));
  assert.ok(!isPlausibleShortCommand("   ", 12));
});

test("parseUseProject extracts alias from pakai/gunakan", () => {
  assert.equal(parseUseProject("pakai toko-online"), "toko-online");
  assert.equal(parseUseProject("gunakan toko-online"), "toko-online");
  assert.equal(parseUseProject("pakai baju baru"), undefined);
});

test("phrase matchers ignore case and whitespace", () => {
  assert.ok(isListProjectsCommand("  Daftar Project  "));
  assert.ok(isHelpCommand("BANTUAN"));
  assert.ok(isStatusCommand("status"));
  assert.ok(isStopCommand("Batalkan"));
  assert.ok(!isStopCommand("batalkan dong ya"));
  assert.ok(isListModelsCommand("Daftar Model"));
});

test("parseUseModel: 2-token form defaults department to 'semua'", () => {
  assert.deepEqual(parseUseModel("pakai model gemini"), { department: "semua", provider: "gemini" });
  assert.deepEqual(parseUseModel("gunakan model openrouter"), { department: "semua", provider: "openrouter" });
  assert.equal(parseUseModel("pakai gemini"), undefined);
});

test("parseUseModel: 3-token form captures department and provider separately", () => {
  assert.deepEqual(parseUseModel("pakai model dev groq"), { department: "dev", provider: "groq" });
  assert.deepEqual(parseUseModel("gunakan model qa openrouter"), { department: "qa", provider: "openrouter" });
});

test("parseUseModel: provider token can carry a /model suffix", () => {
  assert.deepEqual(parseUseModel("pakai model gemini/gemini-3.5-flash"), {
    department: "semua",
    provider: "gemini/gemini-3.5-flash",
  });
  assert.deepEqual(parseUseModel("pakai model dev openrouter/qwen/qwen3-coder:free"), {
    department: "dev",
    provider: "openrouter/qwen/qwen3-coder:free",
  });
});

test("parseListModelsForProvider extracts provider and search keyword", () => {
  assert.deepEqual(parseListModelsForProvider("daftar model gemini flash"), {
    provider: "gemini",
    query: "flash",
  });
  assert.deepEqual(parseListModelsForProvider("list model openrouter qwen coder"), {
    provider: "openrouter",
    query: "qwen coder",
  });
  assert.equal(parseListModelsForProvider("daftar model gemini"), undefined);
});

test("parseAddFolder extracts alias and path, including paths with spaces", () => {
  assert.deepEqual(parseAddFolder("tambah folder kerja D:/my-product/agent-engineer-system"), {
    alias: "kerja",
    path: "D:/my-product/agent-engineer-system",
  });
  assert.deepEqual(parseAddFolder("tambah folder dokumen C:/Users/User/My Documents"), {
    alias: "dokumen",
    path: "C:/Users/User/My Documents",
  });
  assert.equal(parseAddFolder("tambah folder cuma-satu-kata"), undefined);
});

test("isConfirmYes/isConfirmNo recognize common replies", () => {
  assert.ok(isConfirmYes("ya"));
  assert.ok(isConfirmYes("Boleh"));
  assert.ok(isConfirmYes("  oke  "));
  assert.ok(!isConfirmYes("tidak"));
  assert.ok(isConfirmNo("tidak"));
  assert.ok(isConfirmNo("Batal"));
  assert.ok(!isConfirmNo("ya"));
});

test("isConfirmYesWithCheckpoints recognizes the checkpoint opt-in phrases only", () => {
  assert.ok(isConfirmYesWithCheckpoints("ya, checkpoint"));
  assert.ok(isConfirmYesWithCheckpoints("Review Tiap Fase"));
  assert.ok(!isConfirmYesWithCheckpoints("ya"));
  assert.ok(!isConfirmYesWithCheckpoints("lanjut"));
});

test("isIntroCommand recognizes common self-introduction questions", () => {
  assert.ok(isIntroCommand("siapa kamu"));
  assert.ok(isIntroCommand("Kamu Siapa?"));
  assert.ok(isIntroCommand("  kenalin dong  "));
  assert.ok(isIntroCommand("who are you"));
  assert.ok(!isIntroCommand("tambahin fitur login dong"));
});

test("isGreetingCommand recognizes common greetings", () => {
  assert.ok(isGreetingCommand("halo"));
  assert.ok(isGreetingCommand("Hai!"));
  assert.ok(isGreetingCommand("  selamat pagi  "));
  assert.ok(isGreetingCommand("apa kabar"));
  assert.ok(isGreetingCommand("Apa Kabar?"));
  assert.ok(!isGreetingCommand("halo, tambahin endpoint health check dong"));
  assert.ok(!isGreetingCommand("tambahin fitur login dong"));
});

test("isConnectFigmaCommand recognizes the Figma linking phrases", () => {
  assert.ok(isConnectFigmaCommand("hubungkan figma"));
  assert.ok(isConnectFigmaCommand("Connect Figma"));
  assert.ok(isConnectFigmaCommand("  sambungkan figma  "));
  assert.ok(!isConnectFigmaCommand("liat desain figma dong"));
});
