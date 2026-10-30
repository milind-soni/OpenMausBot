import assert from "node:assert/strict";
import test from "node:test";
import { clashPath, cloudReserveBytes, foldKey, neverFromCloud, safeFolderName, skipped, validWirePath, windowsProblem } from "./cloud-sync-rules.mjs";

test("skips build folders, system litter, lock and temporary files, and sync's own downloads", () => {
  for (const dir of ["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".cache"]) assert.equal(skipped(dir, true), true, dir);
  assert.equal(skipped("src", true), false);
  for (const file of [".DS_Store", "Thumbs.db", "desktop.ini", "~$port.docx", "draft.tmp", "movie.crdownload", "a.part", ".~lock.sheet.ods#", ".Report.docx.omb-sync-1a2b3c4d"]) {
    assert.equal(skipped(file, false), true, file);
  }
  assert.equal(skipped("Report.docx", false), false);
  assert.equal(skipped("node_modules", false), false, "only a directory by that name is skipped");
});

test("a wire path is relative, slash-separated and NFC", () => {
  for (const good of ["a.txt", "a/b.txt", "Café/x.md"]) assert.equal(validWirePath(good), true, good);
  for (const bad of ["", "/a", "a//b", "a/./b", "../a", "a/..", "a\\b", "a\0b", "Café.txt", 7, null]) assert.equal(validWirePath(bad), false, String(bad));
});

test("wire paths reject unpaired surrogates and accept Unicode scalar values", () => {
  for (const good of ["\ufffd.txt", "\ud83d\udcc4.txt", "docs/\ud83d\udcc4.txt"]) assert.equal(validWirePath(good), true, good);
  for (const bad of ["\ud800.txt", "\ud801.txt", "\udbff.txt", "\udc00.txt", "\udfff.txt", "docs/\ud800.txt", "a\ud800", "\udc00\ud800.txt"]) {
    assert.equal(validWirePath(bad), false, JSON.stringify(bad));
  }
});

test("names a Windows PC cannot hold", () => {
  assert.equal(windowsProblem("a/b:c.txt"), "characters");
  assert.equal(windowsProblem("notes./x"), "trailing");
  assert.equal(windowsProblem("notes /x"), "trailing");
  assert.equal(windowsProblem("CON.txt"), "reserved");
  assert.equal(windowsProblem("x/lpt9"), "reserved");
  assert.equal(windowsProblem("Reports/Q3.xlsx"), null);
});

test("case and Unicode form fold together", () => {
  assert.equal(foldKey("Café/A.txt"), foldKey("café/a.TXT"));
  assert.notEqual(foldKey("a.txt"), foldKey("b.txt"));
});

test("a clash copy is named for the PC and the day, then numbered", () => {
  const at = new Date(2026, 9, 15, 12).getTime();
  assert.equal(clashPath("docs/report.docx", at, () => false), "docs/report (PC copy, 15 Oct 2026).docx");
  const taken = new Set(["docs/report (PC copy, 15 Oct 2026).docx"]);
  assert.equal(clashPath("docs/report.docx", at, (path) => taken.has(path)), "docs/report (PC copy, 15 Oct 2026 2).docx");
  assert.equal(clashPath("Makefile", at, () => false), "Makefile (PC copy, 15 Oct 2026)");
  assert.equal(clashPath(".env", at, () => false), ".env (PC copy, 15 Oct 2026)");
  assert.equal(clashPath("a.txt", at, () => false, "restored"), "a (restored, 15 Oct 2026).txt");
});

test("folder names both Windows and macOS hold, without clashing", () => {
  assert.equal(safeFolderName("Q3: plan?", new Set()), "Q3- plan-");
  assert.equal(safeFolderName("notes. ", new Set()), "notes");
  assert.equal(safeFolderName("CON", new Set()), "_CON");
  assert.equal(safeFolderName("con.d", new Set()), "_con.d");
  assert.equal(safeFolderName("COM\u00b9", new Set()), "_COM\u00b9");
  // Cut first, then trimmed: never a trailing space or dot.
  assert.equal(safeFolderName(`${"a".repeat(79)} b`, new Set()), "a".repeat(79));
  assert.equal(safeFolderName("x\u202ey", new Set()), "x-y");
  assert.equal(safeFolderName("   ", new Set()), "Untitled");
  assert.equal(safeFolderName("Research", new Set(["research"])), "Research (2)");
  assert.equal(safeFolderName("Research", new Set(["research", "research (2)"])), "Research (3)");
});

test("never brings down an agent's or tool's config, or what sync skips, from My Cloud; refuses direction overrides", () => {
  for (const path of [".mcp.json", "x/.MCP.json", "CLAUDE.md", "docs/Agents.md", ".claude/settings.json", ".Claude/hooks.json", ".codex/config.toml", ".vscode/tasks.json", ".github/workflows/ci.yml", "a.code-workspace", ".envrc", ".git/config", "node_modules/x.js"]) {
    assert.equal(neverFromCloud(path), true, path);
  }
  for (const path of [".git", "x/.git", ".GIT/config", ".Git/hooks/pre-commit", "repo/.git/HEAD", ".hg/hgrc", ".svn/entries", ".jj/repo", ".bzr/branch",
    ".devcontainer/devcontainer.json", "Node_Modules/a.js", ".VENV/bin/activate"]) {
    assert.equal(neverFromCloud(path), true, path);
  }
  for (const path of ["report.md", "docs/readme.md", "claude-notes.md", "notes/.gitignore", "my.git/readme.md", "Git notes.md", "venv"]) {
    assert.equal(neverFromCloud(path), false, path);
  }
  assert.equal(validWirePath("invoice\u202efdp.exe"), false);
  assert.equal(validWirePath("caf\u00e9.txt"), true);
});

test("My Cloud keeps at least 2 GB or 15% of its disk free", () => {
  assert.equal(cloudReserveBytes(10 * 1024 ** 3), 2 * 1024 ** 3);
  assert.equal(cloudReserveBytes(50 * 1024 ** 3), Math.ceil(50 * 1024 ** 3 * 0.15));
});
