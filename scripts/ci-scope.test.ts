import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ALL_OS, AREA_CHECKS, ciOutputs, FULL_LANE_EVENTS, FULL_SCOPE, laneOf, MAIN_SCOPE, QUEUED_SCOPE, SELECTABLE_JOBS, selectCiScope,
  selectPushScope, SRC_OUTSIDE_RENDERER, versionOnlyPackageJson, VITEST_SUBSETS, vitestMatrix,
} from "./ci-scope.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
const ALL = ["macos-latest", "ubuntu-latest", "windows-latest"];
const PR = ["ubuntu-latest", "windows-latest"];
const MAIN = ["ubuntu-latest"];
const SERVER_JOBS = ["vitest", "behavior-evals", "packaged-server", "electron-smokes", "foss", "ui-smoke", "browser-identity", "package-linux", "browser-driver"];
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
  return { output: outputs(readFileSync(outputPath, "utf8")), stderr: result.stderr };
}

/** The GITHUB_OUTPUT lines ci-scope wrote, each value parsed. */
function outputs(text: string) {
  return Object.fromEntries(text.trimEnd().split("\n").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), JSON.parse(line.slice(at + 1))];
  }));
}

const packaged = (oses: string[]) => oses.filter((os) => os !== "macos-latest");
const everything = (oses: string[]) => ({ build: true, jobs: SELECTABLE_JOBS, vitest_os: oses, packaged_server_os: packaged(oses), vitest_matrix: vitestMatrix(oses) });
const staticOnly = (oses: string[], build: boolean) => ({ build, jobs: [], vitest_os: oses, packaged_server_os: packaged(oses), vitest_matrix: vitestMatrix(oses) });
/** What a push to main and a merge group run: Linux's shards, the macOS smokes and the short Linux checks. */
const MAIN_JOBS = ["vitest", "behavior-evals", "packaged-server", "electron-smokes", "foss", "control-plane", "ui-smoke", "browser-identity"];
const mainLane = () => ({ build: true, jobs: MAIN_JOBS, vitest_os: MAIN, packaged_server_os: MAIN, vitest_matrix: vitestMatrix(MAIN) });

describe("vitest matrix", () => {
  it("gives Linux and Windows eight shards each and macOS four, and only Linux every e2e file", () => {
    const { include } = vitestMatrix(["macos-latest", "ubuntu-latest", "windows-latest"]);
    const count = (os: string) => include.filter((entry) => entry.os === os).length;
    expect([count("ubuntu-latest"), count("windows-latest"), count("macos-latest")]).toEqual([8, 8, 4]);
    expect(include.find((entry) => entry.os === "windows-latest" && entry.shard === 8))
      .toEqual({ os: "windows-latest", part: "shard 8/8", shard: 8, shards: 8, files: "", e2e: "host", node_tests: false });
    expect(include.filter((entry) => entry.node_tests).map((entry) => [entry.os, entry.shard]))
      .toEqual([["macos-latest", 1], ["ubuntu-latest", 1], ["windows-latest", 1]]);
    expect(include.filter((entry) => entry.e2e === "all").every((entry) => entry.os === "ubuntu-latest")).toBe(true);
  });

  it("keeps a pull request's shards off macOS", () => {
    expect(vitestMatrix(["ubuntu-latest", "windows-latest"]).include.some((entry) => entry.os === "macos-latest")).toBe(false);
  });
});

const checks = (...areas: string[]) => [...new Set(areas.flatMap((area) => AREA_CHECKS[area as keyof typeof AREA_CHECKS]))].sort();

describe("CI path scope", () => {
  it("runs only the docs tests, without the build, for documentation, its evidence and the docs site", () => {
    expect(selectCiScope([
      "README.md", "AGENTS.md", "docs/guide.md", "docs/nested/guide.md", ".github/FUNDING.yml", "apps/docs/content/index.mdx",
      "docs/verification/evidence/mentions/rtl-dom.json", "docs/screenshots/home.png",
    ])).toEqual({ areas: ["docs"], checks: ["docs-tests"] });
  });

  it("runs a test under scripts/ wherever the suite runs, without the build", () => {
    expect(selectCiScope(["scripts/generate-locale.test.mjs", "scripts/testing/control-omb-ui.e2e.test.ts"]))
      .toEqual({ areas: ["script-tests"], checks: ["browser-identity", "host-tests", "linux-tests", "ui-smoke"] });
  });

  it("runs the build, the Linux shards and the renderer smoke for a renderer change", () => {
    expect(selectCiScope(["src/App.tsx", "public/icon.svg", "cloud-buy-preview.html", "src/locales/en.json", "docs/guide.md"]))
      .toEqual({ areas: ["docs", "web"], checks: ["build", "docs-tests", "linux-tests", "ui-smoke"] });
  });

  it("runs the locale tests alone for translations, their tests and their hashes", () => {
    expect(selectCiScope(["src/locales/de.json", "src/locales/source-hashes.json", "src/locales/words.test.ts"]))
      .toEqual({ areas: ["locales"], checks: ["build", "locale-tests"] });
    expect(selectCiScope(["src/locales/index.ts"]).areas).toEqual(["web"]);
  });

  it.each([
    ["server/index.ts"], ["shared/types.ts"], ["companion/src/index.ts"], ["enterprise/license.ts"], ["evals/runners/run-evals.ts"],
    ["skills/pdf/SKILL.md"], ["cloudflare/composio-broker/src/index.ts"], ["Dockerfile"], ["deploy/podman/run.sh"],
    ...SRC_OUTSIDE_RENDERER.map((file) => [file]),
  ])("runs every check that runs the server for %j", (file) => {
    expect(selectCiScope([file])).toEqual({ areas: ["server"], checks: checks("server") });
  });

  it.each([["electron/main.mjs"], ["build/icon.icns"], ["electron-builder.yml"], ["index.html"]])("runs the server's checks for the desktop's %j", (file) => {
    expect(selectCiScope([file])).toEqual({ areas: ["desktop"], checks: checks("server") });
  });

  it("runs only the control-plane job for the control plane", () => {
    expect(selectCiScope(["cloudflare/control-plane/src/index.ts"])).toEqual({ areas: ["control-plane"], checks: ["control-plane"] });
  });

  it("selects every area's checks for a change across areas", () => {
    expect(selectCiScope(["src/App.tsx", "src/locales/de.json", "cloudflare/control-plane/src/index.ts"]))
      .toEqual({ areas: ["control-plane", "locales", "web"], checks: ["build", "control-plane", "linux-tests", "locale-tests", "ui-smoke"] });
  });

  it("keeps filenames containing newlines as one path that can affect anything", () => {
    expect(selectCiScope(["src/first.md\nsecond.md"])).toEqual(FULL_SCOPE);
    expect(selectCiScope(["first\nsecond.md"])).toEqual(FULL_SCOPE);
  });

  it.each([
    [], [""], ["docs/../server/file.md"], ["./src/App.tsx"],
    [".github/workflows/ci.yml"], ["scripts/ci-scope.mjs"], ["scripts/testing/host-e2e.ts"], [".gitattributes"],
    ["package.json"], ["pnpm-lock.yaml"], ["pnpm-workspace.yaml"], ["tsconfig.json"], ["vite.config.ts"], [".oxlintrc.json"],
    ["third_party/browser/agent-browser-windows-stdio.patch"], ["scripts/testing/ci-retry-runner.ts"], ["unknown/file"], ["src/App.tsx", "package.json"],
  ])("runs everything for %j", (...files) => {
    expect(selectCiScope(files)).toEqual(FULL_SCOPE);
  });

  it("lists every check in some area and every check of an area in the full scope", () => {
    const named = new Set(Object.values(AREA_CHECKS).flat());
    for (const job of SELECTABLE_JOBS.filter((job) => job !== "vitest")) expect(named.has(job), job).toBe(true);
    for (const check of named) expect(check in VITEST_SUBSETS || FULL_SCOPE.checks.includes(check), check).toBe(true);
  });
});

describe("CI outputs", () => {
  it("runs a renderer change's tests on Linux only", () => {
    const out = ciOutputs(selectCiScope(["src/App.tsx"]), PR);
    expect(out).toEqual({ build: true, jobs: ["vitest", "ui-smoke"], vitest_os: PR, packaged_server_os: PR, vitest_matrix: vitestMatrix(["ubuntu-latest"]) });
  });

  it("runs a server change's tests on Linux and Windows, and its other checks", () => {
    expect(ciOutputs(selectCiScope(["server/index.ts"]), PR)).toEqual({ build: true, jobs: SERVER_JOBS, vitest_os: PR, packaged_server_os: PR, vitest_matrix: vitestMatrix(PR) });
  });

  it("runs the locale tests in their own shards, with the Electron node tests, when no full Linux run covers them", () => {
    const out = ciOutputs(selectCiScope(["src/locales/de.json"]), PR);
    expect(out.jobs).toEqual(["vitest"]);
    expect(out.vitest_matrix.include).toEqual([1, 2].map((shard) => ({
      os: "ubuntu-latest", part: `locale tests ${shard}/2`, shard, shards: 2,
      files: "src/ scripts/generate-locale.test.mjs scripts/testing/key-readback.e2e.test.ts", e2e: "all", node_tests: shard === 1,
    })));
    expect(ciOutputs(selectCiScope(["src/locales/de.json", "src/App.tsx"]), PR).vitest_matrix).toEqual(vitestMatrix(["ubuntu-latest"]));
  });

  it("runs the docs tests in one job for docs, and skips the build", () => {
    const out = ciOutputs(selectCiScope(["docs/analytics.md"]), PR);
    expect(out).toMatchObject({ build: false, jobs: ["vitest"] });
    expect(out.vitest_matrix.include).toEqual([{
      os: "ubuntu-latest", part: "docs tests", shard: 1, shards: 1, files: VITEST_SUBSETS["docs-tests"].files.join(" "), e2e: "all", node_tests: false,
    }]);
    expect(ciOutputs(selectCiScope(["docs/analytics.md", "src/locales/de.json"]), PR).vitest_matrix.include.map((entry: { part: string }) => entry.part))
      .toEqual(["locale tests 1/2", "locale tests 2/2", "docs tests"]);
  });

  it("skips the build and every job when nothing is selected, keeping a full matrix for the skipped vitest job", () => {
    expect(ciOutputs({ checks: [] }, PR)).toEqual(staticOnly(PR, false));
  });

  it("runs every job, on every platform the event covers, for the full scope", () => {
    expect(ciOutputs(FULL_SCOPE, ALL)).toEqual(everything(ALL));
    expect(ciOutputs(FULL_SCOPE, PR)).toEqual(everything(PR));
  });

  it("puts every e2e-capable platform's shards in the vitest job only when its tests are selected", () => {
    const windows = ciOutputs({ checks: ["host-tests"] }, ALL).vitest_matrix.include;
    expect(new Set(windows.map((entry: { os: string }) => entry.os))).toEqual(new Set(["macos-latest", "windows-latest"]));
  });

  it("runs Linux's every shard, the macOS smokes and the short Linux checks for main, and nothing on Windows", () => {
    const out = ciOutputs(MAIN_SCOPE, MAIN);
    expect(out).toEqual(mainLane());
    expect(out.vitest_matrix.include).toHaveLength(8);
    expect(out.jobs).not.toEqual(expect.arrayContaining(["windows-cua"]));
    for (const job of ["windows-cua", "package-linux", "browser-driver", "cloudflared-linux-arm64"]) expect(out.jobs, job).not.toContain(job);
    expect(MAIN_SCOPE.checks.every((check) => FULL_SCOPE.checks.includes(check))).toBe(true);
  });

  it("runs only the broker's control-plane checks for a commit the merge queue already tested", () => {
    expect(ciOutputs(QUEUED_SCOPE, MAIN)).toEqual({ ...staticOnly(MAIN, false), jobs: ["control-plane"] });
  });

  it("names each event's lane: a pull request its areas, main and the merge queue Linux, the rest every platform", () => {
    expect(laneOf("pull_request")).toBe("pr");
    expect(laneOf("push")).toBe("main");
    expect(laneOf("merge_group")).toBe("main");
    for (const event of FULL_LANE_EVENTS) expect(laneOf(event), event).toBe("full");
    expect(FULL_LANE_EVENTS).toEqual(["schedule", "workflow_dispatch"]);
    expect(ALL_OS).toEqual(ALL);
  });
});

/** Relative imports, `@/` included, that load code when run; `import type` loads nothing. */
const IMPORT = /(?:^|[^\w$.])(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']|(?:^|[^\w$.])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;
const CODE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|node-test)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|testing|fixtures)\//;

function codeFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? codeFiles(path) : CODE.test(entry.name) ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string) {
  const base = (specifier.startsWith("@/") ? join(ROOT, "src", specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null)
    ?.replace(/\?.*$/, "");
  if (!base) return null;
  const candidates = [base, base.replace(/\.js$/, ".ts"), ...["ts", "tsx", "mjs", "cjs", "js"].map((extension) => `${base}.${extension}`),
    ...["ts", "tsx", "js"].map((extension) => join(base, `index.${extension}`))];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const importsOf = new Map<string, string[]>();
function imports(file: string) {
  if (!importsOf.has(file)) {
    importsOf.set(file, CODE.test(file)
      ? [...readFileSync(file, "utf8").matchAll(IMPORT)].flatMap((match) => resolveImport(file, match[1] ?? match[2]) ?? [])
      : []);
  }
  return importsOf.get(file)!;
}

/** Every repository file the given files load, transitively, themselves included. */
function importClosure(entries: string[]) {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...imports(file).filter((target) => !seen.has(target)));
  }
  return [...seen].map((file) => relative(ROOT, file).split("\\").join("/"));
}

describe("the repository's import graph", () => {
  it("lists every renderer file the server, Electron, the companion, evals, the workers or the macOS frame smoke load", () => {
    const frameSmoke = readFileSync(join(ROOT, "scripts/smoke-app-frames.mjs"), "utf8");
    expect(frameSmoke).toContain('resolveDir: join(ROOT, "src/components/app")');
    expect(frameSmoke).toContain("from \\\"./app-frame-host.ts\\\"");
    const runtime = ["server", "shared", "electron", "companion", "enterprise", "evals", "cloudflare"]
      .flatMap((directory) => codeFiles(join(ROOT, directory)))
      .filter((file) => !TEST_FILE.test(relative(ROOT, file).split("\\").join("/")));
    expect(runtime.length).toBeGreaterThan(500);
    const loaded = importClosure([...runtime, join(ROOT, "src/components/app/app-frame-host.ts")]).filter((file) => file.startsWith("src/"));
    expect(loaded.sort()).toEqual([...SRC_OUTSIDE_RENDERER].sort());
  });

  it("runs every test outside the renderer that reads a translation other than English with the locale tests", () => {
    const files = ["server", "shared", "electron", "companion", "enterprise", "evals", "scripts", "cloudflare"]
      .flatMap((directory) => codeFiles(join(ROOT, directory)))
      // The selection names the catalogs without reading them.
      .filter((file) => !/[/\\]ci-scope\.(?:mjs|test\.ts)$/.test(file));
    const mentionsTranslations = (file: string) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/locales/g)].some((match) => !/^locales\W{1,6}en\.json/.test(text.slice(match.index, match.index + 24)));
    };
    const readers = new Set(files.filter(mentionsTranslations));
    const affected = files
      .filter((file) => /\.test\.[cm]?[jt]s$/.test(file))
      .filter((file) => importClosure([file]).some((loaded) => /^src\/locales\/(?!en\.json$)/.test(loaded) || readers.has(join(ROOT, loaded))))
      .map((file) => relative(ROOT, file).split("\\").join("/"));
    expect(affected).toContain("scripts/generate-locale.test.mjs");
    // The Electron node tests, which compare their own copy of some strings with every catalog, run on the locale tests' first shard.
    expect(affected.filter((file) => !VITEST_SUBSETS["locale-tests"].files.some((filter) => file.includes(filter)))).toEqual([]);
  });

  it("runs every test that reads the docs with the docs tests or in static", () => {
    const ci = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    const inStatic = (ci.jobs.static.steps as { run?: string }[]).flatMap((step) => step.run?.startsWith("pnpm exec vitest run ") ? step.run.split(" ").slice(4) : []);
    expect(inStatic).toContain("scripts/testing/verification-docs.test.ts");
    // A docs path a test reads from the repository root: join(ROOT, "docs", ...), new URL("docs/...", ROOT) or read("docs/...").
    const DOCS_READ = /(?:(?:join|resolve)\(\s*ROOT\s*,\s*|new URL\(\s*|\bread\w*\(\s*)["'`]((?:apps\/docs|docs)\b[^"'`]*|[A-Z][A-Z_]+\.md)["'`]/g;
    const readers = ["server", "shared", "electron", "companion", "enterprise", "evals", "scripts", "src", "cloudflare"]
      .flatMap((directory) => codeFiles(join(ROOT, directory)))
      .filter((file) => /\.(?:test|node-test)\.[cm]?[jt]sx?$/.test(file) && !file.endsWith("ci-scope.test.ts"))
      .filter((file) => [...readFileSync(file, "utf8").replace(/(["'`])\s*,\s*(["'`])/g, "/").matchAll(DOCS_READ)]
        .some((match) => existsSync(join(ROOT, match[1]))))
      .map((file) => relative(ROOT, file).split("\\").join("/"))
      .sort();
    expect(readers).toEqual([...VITEST_SUBSETS["docs-tests"].files, ...inStatic.filter((file) => file === "scripts/testing/verification-docs.test.ts")].sort());
  });

  it("never loads a test file from other code, so a test under scripts/ affects only the jobs that run it", () => {
    const code = ["server", "shared", "electron", "companion", "enterprise", "evals", "scripts", "src", "cloudflare"]
      .flatMap((directory) => codeFiles(join(ROOT, directory)));
    const loaders = code.filter((file) => imports(file).some((target) => /\.test\.[cm]?[jt]sx?$/.test(target)));
    expect(loaders.map((file) => relative(ROOT, file))).toEqual([]);
  });
});

describe("CI scope CLI", () => {
  it("runs only the docs tests, without the build, for a docs-only pull request", () => {
    const { directory, git, base } = fixture("docs/guide.md");
    writeFileSync(join(directory, "docs/guide.md"), "updated guide\n");
    git("commit", "--quiet", "-am", "docs");
    const { output, stderr } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toEqual(ciOutputs({ checks: ["docs-tests"] }, PR));
    expect(output).toMatchObject({ build: false, jobs: ["vitest"] });
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
    expect(output).toEqual(ciOutputs({ checks: ["docs-tests"] }, PR));
    expect(output).toMatchObject({ build: false, jobs: ["vitest"] });
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
    expect(output).toEqual({ build: true, jobs: SERVER_JOBS, vitest_os: PR, packaged_server_os: PR, vitest_matrix: vitestMatrix(PR) });
    expect(stderr).toBe("");
  });

  it("runs a renderer pull request's tests on Linux, and a translation pull request's locale tests", () => {
    for (const [source, jobs, oses] of [["src/App.tsx", ["vitest", "ui-smoke"], ["ubuntu-latest"]], ["src/locales/de.json", ["vitest"], []]] as const) {
      const { directory, git, base } = fixture(source);
      writeFileSync(join(directory, source), "changed\n");
      git("commit", "--quiet", "-am", "change");
      const { output, stderr } = run(directory, "pull_request", {
        pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
      });
      expect(output).toEqual(ciOutputs(selectCiScope([source]), PR));
      expect(output.jobs).toEqual(jobs);
      expect(output.vitest_matrix.include.filter((entry: { files: string }) => !entry.files).map((entry: { os: string }) => entry.os))
        .toEqual(oses.flatMap((os) => Array(8).fill(os)));
      expect(stderr).toBe("");
    }
  });

  it("reads filenames with spaces without turning source into docs", () => {
    const source = "src/first second.md";
    const { directory, git, base } = fixture(source);
    writeFileSync(join(directory, source), "changed\n");
    git("commit", "--quiet", "-am", "change");
    const { output } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toEqual(ciOutputs({ checks: AREA_CHECKS.web }, PR));
  });

  it.each(["missing", "invalid", "unavailable", "empty"])("falls back loudly for a %s diff", (kind) => {
    const { directory, base } = fixture();
    const payload = kind === "missing" ? {} : {
      pull_request: { base: { sha: base }, head: { sha: kind === "invalid" ? "--help" : kind === "unavailable" ? "f".repeat(40) : base } },
    };
    const { output, stderr } = run(directory, "pull_request", payload);
    expect(output).toEqual(everything(ALL));
    expect(stderr).toContain("using all checks");
  });

  it.each(["schedule", "workflow_dispatch"])("runs everything on every platform for %s", (event) => {
    const { directory } = fixture("docs/guide.md");
    expect(run(directory, event, {}).output).toEqual(everything(ALL));
  });

  it("runs main's checks for a merge group, whatever it changes", () => {
    const { directory } = fixture("docs/guide.md");
    expect(run(directory, "merge_group", { merge_group: { head_sha: "f".repeat(40) } }).output).toEqual(mainLane());
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

  it("never narrows a push the way it narrows a pull request", () => {
    const show = () => pkg("0.1.100");
    for (const file of ["apps/docs/content/index.mdx", "src/locales/de.json", "src/App.tsx", "cloudflare/control-plane/src/index.ts", "server/index.ts"]) {
      expect(selectPushScope([file], show), file).toEqual({ runtime: true });
    }
    expect(selectPushScope([], show)).toEqual({ runtime: true });
  });
});

type FakeRun = { id?: number; event: string; status: string; conclusion: string | null };

/** A GitHub that answers the CI runs of one commit and the jobs of one run; the
 * script under test runs asynchronously so this server can answer it. */
async function fakeRunsApi(runs: Record<string, FakeRun[]>, jobs: Record<number, Array<{ name: string; conclusion: string | null }>> = {}) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    const url = new URL(request.url!, "http://x");
    const sha = url.searchParams.get("head_sha") ?? "";
    const runId = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname)?.[1];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(runId ? { jobs: jobs[Number(runId)] ?? [] } : { workflow_runs: runs[sha] ?? [] }));
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
  return { output: outputs(readFileSync(outputPath, "utf8")), stderr };
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
  const code = (directory: string) => writeFileSync(join(directory, "server/index.ts"), "changed\n");
  const green = [{ event: "push", status: "completed", conclusion: "success" }];
  const runsOf = (sha: string) => `GET /repos/o/r/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100 Bearer t`;
  const github = (api: { url: string }) => ({ GITHUB_API_URL: api.url, GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" });

  it.each([["the version bump", bump], ["a docs-only merge", docs]])("skips the runtime jobs for %s after a green commit", async (_, change) => {
    const { directory, before, after } = pushFixture(change);
    const api = await fakeRunsApi({ [before]: [{ event: "pull_request", status: "completed", conclusion: "failure" }, ...green] });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(staticOnly(MAIN, true));
      expect(stderr).toBe("");
      expect(api.requests).toEqual([runsOf(after), runsOf(before)]);
    } finally {
      await api.close();
    }
  });

  it.each([["a code change", code], ["the version bump", bump]])("runs only the control-plane checks for %s the merge queue already passed", async (_, change) => {
    const { directory, before, after } = pushFixture(change);
    // The queue lands its group's commit once the gate passes, before the run's last job has finished.
    const api = await fakeRunsApi({ [after]: [{ id: 77, event: "merge_group", status: "in_progress", conclusion: null }] }, {
      77: [{ name: "vitest (ubuntu-latest, shard 1/8)", conclusion: "success" }, { name: "CI", conclusion: "success" }],
    });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(ciOutputs(QUEUED_SCOPE, MAIN));
      expect(stderr).toBe("");
    } finally {
      await api.close();
    }
  });

  it.each([
    ["failed its gate", [{ name: "CI", conclusion: "failure" }]],
    ["has not passed its gate yet", [{ name: "CI", conclusion: null }]],
  ])("runs main's checks for a commit whose merge-group run %s", async (_, gateJobs) => {
    const { directory, before, after } = pushFixture(code);
    const api = await fakeRunsApi({ [after]: [{ id: 78, event: "merge_group", status: "completed", conclusion: "failure" }] }, { 78: gateJobs });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(mainLane());
      expect(stderr).toBe("");
      expect(api.requests).toEqual([runsOf(after), "GET /repos/o/r/actions/runs/78/jobs?per_page=100 Bearer t"]);
    } finally {
      await api.close();
    }
  });

  it.each([
    ["was replaced by this push", [{ event: "push", status: "completed", conclusion: "cancelled" }]],
    ["failed", [{ event: "push", status: "completed", conclusion: "failure" }]],
    ["never ran", []],
    ["only passed as a pull request", [{ event: "pull_request", status: "completed", conclusion: "success" }]],
  ])("runs main's checks for a version bump when the commit before it %s", async (_, runs) => {
    const { directory, before, after } = pushFixture(bump);
    const api = await fakeRunsApi({ [before]: runs });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(mainLane());
      expect(stderr).toContain("has no green CI run of its own");
    } finally {
      await api.close();
    }
  });

  it("runs main's checks when the pushed commit's CI cannot be read", async () => {
    const { directory, before, after } = pushFixture(bump);
    const { output, stderr } = await runPush(directory, { before, after }, { GH_TOKEN: undefined, GITHUB_REPOSITORY: undefined });
    expect(output).toEqual(mainLane());
    expect(stderr).toContain("using main's checks");
  });

  it.each([
    ["a code change", code],
    ["a version bump with a dependency", (directory: string) => writeFileSync(join(directory, "package.json"), pkg("0.1.101", { dependencies: { zod: "4" } }))],
    ["a version bump with code", (directory: string) => { bump(directory); code(directory); }],
  ])("runs main's checks for %s, asking GitHub only about the merge queue", async (_, change) => {
    const { directory, before, after } = pushFixture(change);
    const api = await fakeRunsApi({ [before]: green });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(mainLane());
      expect(stderr).toBe("");
      expect(api.requests).toEqual([runsOf(after)]);
    } finally {
      await api.close();
    }
  });

  it.each([
    ["a missing payload", {}],
    ["a new branch", { before: "0".repeat(40), after: "f".repeat(40) }],
    ["an unknown commit", { before: "f".repeat(40), after: "e".repeat(40) }],
  ])("falls back loudly to main's checks for %s", async (_, payload) => {
    const { directory } = fixture();
    const { output, stderr } = await runPush(directory, payload, {});
    expect(output).toEqual(mainLane());
    expect(stderr).toContain("using main's checks");
  });
});
