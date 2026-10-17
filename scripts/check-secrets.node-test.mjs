import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  MAX_REPORTED_FINDINGS,
  SecretScanOperationalError,
  runCli,
  scanAddedLine,
  scanDiffStream,
  scanRepository,
} from "./check-secrets.mjs";

const fakeGithubToken = ["ghp", "_123456789012345678901234567890"].join("");
const fakeAwsKey = ["AKIA", "1234567890ABCDEF"].join("");
const fakePrivateKey = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

function repoFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "openmaus-secret-gate-"));
  const git = (args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Secret Gate Test"]);
  writeFileSync(join(cwd, "baseline.txt"), "safe baseline\n");
  git(["add", "."]);
  git(["commit", "-qm", "baseline"]);
  return { cwd, git };
}

test("detects high-signal patterns and credential assignments without retaining values", () => {
  const findings = [
    ...scanAddedLine(fakePrivateKey, "src/config.ts", 3),
    ...scanAddedLine(fakeAwsKey, "src/config.ts", 4),
    ...scanAddedLine(`token = "${fakeGithubToken}"`, "src/config.ts", 5),
  ];
  assert.deepEqual(
    findings.map(({ line, rule }) => ({ line, rule })),
    [
      { line: 3, rule: "private-key" },
      { line: 4, rule: "aws-access-key" },
      { line: 5, rule: "provider-key" },
      { line: 5, rule: "credential-assignment" },
    ],
  );
  assert.ok(findings.every((finding) => Object.keys(finding).sort().join(",") === "file,line,rule"));
});

test("accepts exact placeholders and limits the inline marker to test fixtures", () => {
  for (const value of ["placeholder", "change-me", "${OPENMAUS_TOKEN}", "process.env.API_KEY", "<token>"]) {
    assert.equal(scanAddedLine(`token = "${value}"`, "src/config.ts", 1).length, 0);
  }
  const marked = `token = "${fakeGithubToken}"; // secret-scan: allow-test-fixture`;
  assert.equal(scanAddedLine(marked, "src/provider.test.ts", 1).length, 0);
  assert.ok(scanAddedLine(marked, "src/provider.ts", 1).length > 0);
});

test("ignores expression-shaped assignments while detecting literal credentials", () => {
  assert.equal(scanAddedLine(["const to", "ken = get", "Token()"].join(""), "src/config.ts", 1).length, 0);
  assert.equal(scanAddedLine(["to", "ken = getToken(", '"literal-secret")'].join(""), "src/config.ts", 2).length, 1);
  assert.equal(scanAddedLine(["to", "ken = ", "unquoted-secret"].join(""), "src/config.ts", 2).length, 1);
  assert.equal(scanAddedLine(["to", "ken = \\\"", "quoted-secret", "\\\""].join(""), "src/config.ts", 3).length, 1);
});

test("parses hunk and secret text split across arbitrary stream chunks", async () => {
  const diff = `+++ b/src/config.ts\n@@ -0,0 +7,1 @@\n+token = "${fakeGithubToken}"\n`;
  const chunks = [diff.slice(0, 5), diff.slice(5, 28), diff.slice(28, 51), diff.slice(51)];
  const report = await scanDiffStream(Readable.from(chunks));
  assert.equal(report.addedLines, 1);
  assert.equal(report.findings[0].file, "src/config.ts");
  assert.equal(report.findings[0].line, 7);
});

test("treats a plus-prefixed payload as hunk content instead of a file header", async () => {
  const diff = `+++ b/src/config.ts\n@@ -0,0 +7,1 @@\n+++ token = "${fakeGithubToken}"\n`;
  const report = await scanDiffStream(Readable.from([diff]));
  assert.equal(report.totalFindings, 2);
  assert.ok(report.findings.every((finding) => finding.file === "src/config.ts"));
  assert.ok(report.findings.every((finding) => finding.line === 7));
});

test("counts only distinct files containing findings", async () => {
  const diff = [
    "diff --git a/safe.txt b/safe.txt",
    "--- /dev/null",
    "+++ b/safe.txt",
    "@@ -0,0 +1,1 @@",
    "+safe addition",
    "diff --git a/secret.txt b/secret.txt",
    "--- /dev/null",
    "+++ b/secret.txt",
    "@@ -0,0 +1,1 @@",
    `+${fakePrivateKey}`,
    "",
  ].join("\n");
  const report = await scanDiffStream(Readable.from([diff]));
  assert.equal(report.files, 2);
  assert.equal(report.totalFindings, 1);
  assert.equal(report.findingFiles, 1);
});

test("bounds retained findings and CLI output while reporting omitted findings", async () => {
  const findingCount = MAX_REPORTED_FINDINGS + 7;
  const body = Array.from(
    { length: findingCount },
    (_, index) => `${fakeAwsKey} synthetic-${index}`,
  ).join("\n");
  const diff = `+++ b/many.txt\n@@ -0,0 +1,${findingCount} @@\n${body
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n")}\n`;
  const report = await scanDiffStream(Readable.from([diff]));
  assert.equal(report.totalFindings, findingCount);
  assert.equal(report.findings.length, MAX_REPORTED_FINDINGS);
  assert.equal(report.omittedFindings, 7);

  const { cwd, git } = repoFixture();
  writeFileSync(join(cwd, "many.txt"), `${body}\n`);
  git(["add", "many.txt"]);
  const errors = [];
  assert.equal(await runCli({ cwd, stdout: () => {}, stderr: (line) => errors.push(line) }), 1);
  assert.equal(errors.length, MAX_REPORTED_FINDINGS + 1);
  assert.match(errors.at(-1), new RegExp(`${findingCount} finding\\(s\\) in 1 file\\(s\\)`));
  assert.match(errors.at(-1), /7 additional finding\(s\) omitted/);
  assert.ok(errors.every((line) => !line.includes(fakeAwsKey)));
});

test("streams a staged diff larger than one MiB without an exec buffer", async () => {
  const { cwd, git } = repoFixture();
  const safeBody = "safe synthetic line\n".repeat(60_000);
  assert.ok(Buffer.byteLength(safeBody) > 1024 * 1024);
  writeFileSync(join(cwd, "large.txt"), `${safeBody}token = "${fakeGithubToken}"\n`);
  git(["add", "large.txt"]);

  const report = await scanRepository({ cwd });
  assert.ok(report.bytes > 1024 * 1024);
  assert.equal(report.mode, "staged");
  assert.ok(report.findings.some((finding) => finding.file === "large.txt"));
});

test("default mode scans only staged additions; base mode scans committed branch additions", async () => {
  const { cwd, git } = repoFixture();
  writeFileSync(join(cwd, "staged.txt"), `token = "${fakeGithubToken}"\n`);
  git(["add", "staged.txt"]);
  writeFileSync(join(cwd, "unstaged.txt"), `token = "${fakeGithubToken}"\n`);

  const staged = await scanRepository({ cwd });
  assert.equal(staged.findings.length, 2);
  assert.ok(staged.findings.every((finding) => finding.file === "staged.txt"));

  git(["commit", "-qm", "branch change"]);
  const branch = await scanRepository({ cwd, mode: { type: "base", ref: "HEAD~1" } });
  assert.equal(branch.mode, "base:HEAD~1");
  assert.ok(branch.findings.every((finding) => finding.file === "staged.txt"));
});

test("redacts CLI findings and returns 0 clean, 1 finding, and 2 operational failure", async () => {
  const { cwd, git } = repoFixture();
  const output = [];
  const errors = [];
  const io = { cwd, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) };
  assert.equal(await runCli(io), 0);

  writeFileSync(join(cwd, "secret.txt"), `token = "${fakeGithubToken}"\n`);
  git(["add", "secret.txt"]);
  assert.equal(await runCli(io), 1);
  assert.ok(errors.some((line) => line.includes("value redacted")));
  assert.ok(errors.every((line) => !line.includes(fakeGithubToken)));

  assert.equal(await runCli({ ...io, argv: ["--base", "missing-ref"] }), 2);
  assert.ok(errors.at(-1).startsWith("Secret scan failed:"));
});

test("fails closed when the bounded diff cap is exceeded", async () => {
  const diff = `+++ b/file.txt\n@@ -0,0 +1,1 @@\n+${"safe".repeat(100)}\n`;
  await assert.rejects(
    scanDiffStream(Readable.from([diff]), { maxBytes: 64 }),
    (error) => error instanceof SecretScanOperationalError && /safety cap/.test(error.message),
  );
});
