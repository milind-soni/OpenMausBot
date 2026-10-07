import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { selectCiScope } from "./ci-scope.mjs";

const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
const ALL_OS = JSON.stringify(["macos-latest", "ubuntu-latest", "windows-latest"]);
const PR_OS = JSON.stringify(["ubuntu-latest", "windows-latest"]);
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(source = "src/page.ts") {
  const directory = mkdtempSync(join(tmpdir(), "omb-ci-scope-"));
  temporaryDirectories.push(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(dirname(join(directory, source)), { recursive: true });
  mkdirSync(join(directory, "docs"), { recursive: true });
  writeFileSync(join(directory, source), "source\n");
  git("add", "--", source);
  git("commit", "--quiet", "-m", "base");
  return { directory, git, base: git("rev-parse", "HEAD") };
}

function run(directory: string, event: string, payload: unknown) {
  const eventPath = join(directory, "event.json");
  const outputPath = join(directory, "output.txt");
  writeFileSync(eventPath, JSON.stringify(payload));
  const result = spawnSync(process.execPath, [script], {
    cwd: directory,
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return { output: readFileSync(outputPath, "utf8"), stderr: result.stderr };
}

describe("CI path scope", () => {
  it("skips the runtime suite only for explicit documentation and metadata", () => {
    expect(selectCiScope(["README.md", "AGENTS.md", "docs/guide.md", "docs/nested/guide.md", ".github/FUNDING.yml"]))
      .toEqual({ runtime: false });
  });

  it("keeps runtime checks for renderer-only changes mixed with docs", () => {
    expect(selectCiScope(["src/App.tsx", "public/icon.svg", "index.html", "docs/guide.md"]))
      .toEqual({ runtime: true });
  });

  it("keeps filenames containing newlines as one source path", () => {
    expect(selectCiScope(["src/first.md\nsecond.md"])).toEqual({ runtime: true });
  });

  it.each([
    [], [""], ["docs/../server/file.md"],
    [".github/workflows/ci.yml"], ["scripts/ci-scope.mjs"], [".gitattributes"],
  ])("runs everything conservatively for %j", (...files) => {
    expect(selectCiScope(files)).toEqual({ runtime: true });
  });

  it.each([
    ["server/index.ts"], ["shared/types.ts"], ["electron/main.mjs"], ["companion/src/index.ts"],
    ["package.json"], ["pnpm-lock.yaml"], ["vite.config.ts"], [".github/workflows/release.yml"],
    ["docs/fixture.json"], ["unknown/file"], ["src/App.tsx", "server/index.ts"], ["scripts/capture-companion-fixtures.mjs"],
  ])("runs the runtime suite for %j", (...files) => {
    expect(selectCiScope(files)).toEqual({ runtime: true });
  });
});

describe("CI scope CLI", () => {
  it("omits both groups for a docs-only pull request", () => {
    const { directory, git, base } = fixture("docs/guide.md");
    writeFileSync(join(directory, "docs/guide.md"), "updated guide\n");
    git("commit", "--quiet", "-am", "docs");
    const { output, stderr } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toBe(`runtime=false\nvitest_os=${PR_OS}\n`);
    expect(stderr).toBe("");
  });

  it("ignores base-only server changes after the pull request diverges", () => {
    const { directory, git, base: common } = fixture("server/original.ts");
    writeFileSync(join(directory, "server/original.ts"), "base-only change\n");
    git("commit", "--quiet", "-am", "base change");
    const base = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "--detach", common);
    writeFileSync(join(directory, "docs/guide.md"), "PR-only guide\n");
    git("add", "--", "docs/guide.md");
    git("commit", "--quiet", "-m", "PR docs");
    const { output, stderr } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toBe(`runtime=false\nvitest_os=${PR_OS}\n`);
    expect(stderr).toBe("");
  });

  it.each(["delete", "rename"])("retains the original source path on %s", (change) => {
    const source = "server/original.ts";
    const { directory, git, base } = fixture(source);
    if (change === "delete") git("rm", "--", source);
    else git("mv", "--", source, "docs/renamed.md");
    git("commit", "--quiet", "-m", change);
    const { output, stderr } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toBe(`runtime=true\nvitest_os=${PR_OS}\n`);
    expect(stderr).toBe("");
  });

  it("reads filenames with spaces without turning source into docs", () => {
    const source = "src/first second.md";
    const { directory, git, base } = fixture(source);
    writeFileSync(join(directory, source), "changed\n");
    git("commit", "--quiet", "-am", "change");
    const { output } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toBe(`runtime=true\nvitest_os=${PR_OS}\n`);
  });

  it.each(["missing", "invalid", "unavailable", "empty"])("falls back loudly for a %s diff", (kind) => {
    const { directory, base } = fixture();
    const payload = kind === "missing" ? {} : {
      pull_request: { base: { sha: base }, head: { sha: kind === "invalid" ? "--help" : kind === "unavailable" ? "f".repeat(40) : base } },
    };
    const { output, stderr } = run(directory, "pull_request", payload);
    expect(output).toBe(`runtime=true\nvitest_os=${ALL_OS}\n`);
    expect(stderr).toContain("using all checks");
  });

  it.each(["push", "merge_group", "workflow_dispatch"])("runs everything for %s", (event) => {
    const { directory } = fixture();
    expect(run(directory, event, {}).output).toBe(`runtime=true\nvitest_os=${ALL_OS}\n`);
  });
});
