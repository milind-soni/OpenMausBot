import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { selectCiScope, selectPushScope, versionOnlyPackageJson } from "./ci-scope.mjs";

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

  it.each(["merge_group", "workflow_dispatch"])("runs everything for %s", (event) => {
    const { directory } = fixture();
    expect(run(directory, event, {}).output).toBe(`runtime=true\nvitest_os=${ALL_OS}\n`);
  });
});

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "openmausbot", private: true, version, scripts: { test: "vitest run" }, ...extra }, null, 2)}\n`;

describe("version-only package.json", () => {
  it("is only a changed top-level version", () => {
    expect(versionOnlyPackageJson(pkg("0.1.100"), pkg("0.1.101"))).toBe(true);
    // the bump writes package.json with npm pkg set; formatting is not a change
    expect(versionOnlyPackageJson(pkg("0.1.100"), JSON.stringify(JSON.parse(pkg("0.1.101"))))).toBe(true);
  });

  it.each([
    ["the same version", pkg("0.1.100"), pkg("0.1.100")],
    ["a dependency added", pkg("0.1.100"), pkg("0.1.101", { dependencies: { zod: "4" } })],
    ["a script changed", pkg("0.1.100"), pkg("0.1.101").replace("vitest run", "vitest run --bail")],
    ["a nested version changed", pkg("0.1.100", { engines: { version: "1" } }), pkg("0.1.101", { engines: { version: "2" } })],
    ["other keys reordered", pkg("0.1.100"), JSON.stringify({ private: true, name: "openmausbot", version: "0.1.101", scripts: { test: "vitest run" } })],
    ["no version before", JSON.stringify({ name: "x" }), JSON.stringify({ name: "x", version: "1.0.0" })],
    ["not JSON", "{", pkg("0.1.101")],
    ["not an object", "[]", "[]"],
  ])("is false for %s", (_, before, after) => {
    expect(versionOnlyPackageJson(before, after)).toBe(false);
  });

  it("scopes a push by its own files", () => {
    const show = (rev: string) => (rev === "before" ? pkg("0.1.100") : pkg("0.1.101"));
    expect(selectPushScope(["package.json"], show)).toEqual({ runtime: false });
    expect(selectPushScope(["docs/ci.md", "README.md"], show)).toEqual({ runtime: false });
    expect(selectPushScope(["package.json", "pnpm-lock.yaml"], show)).toEqual({ runtime: true });
    expect(selectPushScope(["package.json", "docs/ci.md"], show)).toEqual({ runtime: true });
    expect(selectPushScope(["server/index.ts"], show)).toEqual({ runtime: true });
    expect(selectPushScope(["package.json"], () => pkg("0.1.100"))).toEqual({ runtime: true });
    expect(selectPushScope(["package.json"], () => { throw new Error("missing"); })).toEqual({ runtime: true });
  });
});

/** A GitHub that answers the CI runs of one commit; the script under test
 * runs asynchronously so this server can answer it. */
async function fakeRunsApi(runs: Record<string, Array<{ event: string; status: string; conclusion: string | null }>>) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    const sha = new URL(request.url!, "http://x").searchParams.get("head_sha") ?? "";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ workflow_runs: runs[sha] ?? [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function runPush(directory: string, payload: unknown, env: Record<string, string | undefined>) {
  const eventPath = join(directory, "event.json");
  const outputPath = join(directory, "output.txt");
  writeFileSync(eventPath, JSON.stringify(payload));
  const childEnv: Record<string, string | undefined> = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const stderr = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [script], { cwd: directory, env: childEnv as NodeJS.ProcessEnv, encoding: "utf8", timeout: 10_000 },
      (error, _stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stderr)));
  });
  return { output: readFileSync(outputPath, "utf8"), stderr };
}

describe("CI scope CLI on a push to main", () => {
  function pushFixture(change: (directory: string) => void) {
    const { directory, git } = fixture("server/index.ts");
    writeFileSync(join(directory, "package.json"), pkg("0.1.100"));
    git("add", "--", "package.json");
    git("commit", "--quiet", "-m", "package");
    const before = git("rev-parse", "HEAD");
    change(directory);
    git("add", "--all");
    git("commit", "--quiet", "-m", "change");
    return { directory, before, after: git("rev-parse", "HEAD") };
  }
  const bump = (directory: string) => writeFileSync(join(directory, "package.json"), pkg("0.1.101"));
  const docs = (directory: string) => writeFileSync(join(directory, "docs/guide.md"), "guide\n");
  const green = [{ event: "push", status: "completed", conclusion: "success" }];

  it.each([["the version bump", bump], ["a docs-only merge", docs]])("skips the runtime jobs for %s after a green commit", async (_, change) => {
    const { directory, before, after } = pushFixture(change);
    const api = await fakeRunsApi({ [before]: [{ event: "pull_request", status: "completed", conclusion: "failure" }, ...green] });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, { GITHUB_API_URL: api.url, GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" });
      expect(output).toBe(`runtime=false\nvitest_os=${ALL_OS}\n`);
      expect(stderr).toBe("");
      expect(api.requests).toEqual([`GET /repos/o/r/actions/workflows/ci.yml/runs?head_sha=${before}&per_page=100 Bearer t`]);
    } finally {
      await api.close();
    }
  });

  it.each([
    ["was replaced by this push", [{ event: "push", status: "completed", conclusion: "cancelled" }]],
    ["failed", [{ event: "push", status: "completed", conclusion: "failure" }]],
    ["never ran", []],
    ["only passed as a pull request", [{ event: "pull_request", status: "completed", conclusion: "success" }]],
  ])("runs everything for a version bump when the commit before it %s", async (_, runs) => {
    const { directory, before, after } = pushFixture(bump);
    const api = await fakeRunsApi({ [before]: runs });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, { GITHUB_API_URL: api.url, GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" });
      expect(output).toBe(`runtime=true\nvitest_os=${ALL_OS}\n`);
      expect(stderr).toContain("has no green CI run of its own");
    } finally {
      await api.close();
    }
  });

  it("runs everything when the previous commit's CI cannot be read", async () => {
    const { directory, before, after } = pushFixture(bump);
    const { output, stderr } = await runPush(directory, { before, after }, { GH_TOKEN: undefined, GITHUB_REPOSITORY: undefined });
    expect(output).toBe(`runtime=true\nvitest_os=${ALL_OS}\n`);
    expect(stderr).toContain("using all checks");
  });

  it.each([
    ["a code change", (directory: string) => writeFileSync(join(directory, "server/index.ts"), "changed\n")],
    ["a version bump with a dependency", (directory: string) => writeFileSync(join(directory, "package.json"), pkg("0.1.101", { dependencies: { zod: "4" } }))],
    ["a version bump with code", (directory: string) => { bump(directory); writeFileSync(join(directory, "server/index.ts"), "changed\n"); }],
  ])("runs everything for %s without asking GitHub", async (_, change) => {
    const { directory, before, after } = pushFixture(change);
    const api = await fakeRunsApi({ [before]: green });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, { GITHUB_API_URL: api.url, GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" });
      expect(output).toBe(`runtime=true\nvitest_os=${ALL_OS}\n`);
      expect(stderr).toBe("");
      expect(api.requests).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it.each([
    ["a missing payload", {}],
    ["a new branch", { before: "0".repeat(40), after: "f".repeat(40) }],
    ["an unknown commit", { before: "f".repeat(40), after: "e".repeat(40) }],
  ])("falls back loudly for %s", async (_, payload) => {
    const { directory } = fixture();
    const { output, stderr } = await runPush(directory, payload, {});
    expect(output).toBe(`runtime=true\nvitest_os=${ALL_OS}\n`);
    expect(stderr).toContain("using all checks");
  });
});
