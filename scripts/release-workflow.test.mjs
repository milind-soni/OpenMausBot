import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Git's Windows checkout converts the workflow to CRLF. The gate is YAML and
// shell source, so test its logical lines rather than the host checkout style.
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  .replace(/\r\n?/g, "\n");
const sha = "0123456789abcdef0123456789abcdef01234567";

const extractGate = () => {
  const marker = "          node --input-type=module <<'EOF'\n";
  const start = workflow.indexOf(marker);
  const end = workflow.indexOf("\n          EOF", start + marker.length);
  if (start < 0 || end < 0) throw new Error("release workflow CI gate script is missing");
  return workflow
    .slice(start + marker.length, end)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
};

const successfulStep = (name) => ({ name, status: "completed", conclusion: "success" });
const job = (name, steps) => ({
  name,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  steps: steps.map(successfulStep),
});

const proof = (runOverrides = {}, jobOverrides = {}) => ({
  runs: {
    workflow_runs: [{
      id: 77,
      head_sha: sha,
      head_branch: "main",
      path: ".github/workflows/ci.yml",
      event: "push",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      ...runOverrides,
    }],
  },
  jobs: {
    total_count: 4,
    jobs: [
      job("typecheck + test (macos-latest)", [
        "Run pnpm typecheck", "Run pnpm test", "Run pnpm check:electron",
      ]),
      job("typecheck + test (ubuntu-latest)", [
        "Run pnpm typecheck", "Run pnpm test", "Run pnpm check:electron", "production UI build",
      ]),
      job("typecheck + test (windows-latest)", [
        "Run pnpm typecheck", "Run pnpm test", "Run pnpm check:electron",
      ]),
      job("package + smoke (Ubuntu 24.04 x64)", [
        "Package from the verified offline CUA stage",
        "Run node scripts/verify-linux-package.mjs",
        "Launch packaged app and verify lifecycle",
      ]),
    ],
    ...jobOverrides,
  },
});

const runGate = async ({ runs, jobs }, { httpStatus = 200 } = {}) => {
  const fetch = vi.fn(async (url) => ({
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: async () => String(url).includes("/jobs?") ? jobs : runs,
  }));
  const fakeProcess = { env: {
    GH_TOKEN: "test-token",
    REPOSITORY: "milind-soni/OpenMausBot",
    RELEASE_SHA: sha,
    DEFAULT_BRANCH: "main",
    GITHUB_API_URL: "https://api.github.test",
  } };
  const log = vi.fn();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const gate = extractGate().replace(
    "const { readFileSync } = await import(\"node:fs\");",
    "const { readFileSync } = fs;",
  );
  await new AsyncFunction("process", "fetch", "URL", "console", "fs", gate)(
    fakeProcess,
    fetch,
    URL,
    { log },
    { readFileSync },
  );
  return { fetch, log };
};

describe("release workflow exact-SHA CI gate", () => {
  it("grants read-only Actions proof access and keeps every build pinned behind prepare", () => {
    expect(workflow).toMatch(/permissions:\n  actions: read\n  contents: read/);
    for (const jobName of ["mac", "windows", "linux"]) {
      expect(workflow).toMatch(new RegExp(
        `  ${jobName}:[\\s\\S]*?needs: prepare[\\s\\S]*?ref: `
          + "\\$\\{\\{ needs\\.prepare\\.outputs\\.sha \\}\\}",
      ));
    }
    expect(workflow).toMatch(/assemble:[\s\S]*?needs: \[prepare, mac, windows, linux\]/);
  });

  it("accepts one complete default-branch push proof for the exact SHA", async () => {
    const { fetch, log } = await runGate(proof());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toContain(`head_sha=${sha}`);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("4 required jobs verified"));
  });

  it("rejects pull-request CI because it tests a synthetic merge ref", async () => {
    await expect(runGate(proof({ event: "pull_request" }))).rejects.toThrow(
      "no successful completed CI push run",
    );
  });

  it("rejects a required package or server step that is not successful", async () => {
    const fixture = proof();
    fixture.jobs.jobs[3].steps.at(-1).conclusion = "failure";
    await expect(runGate(fixture)).rejects.toThrow(
      "Launch packaged app and verify lifecycle",
    );
  });

  it("rejects CI job evidence bound to a different commit", async () => {
    const fixture = proof();
    fixture.jobs.jobs[0].head_sha = "ffffffffffffffffffffffffffffffffffffffff";
    await expect(runGate(fixture)).rejects.toThrow("not a completed success for exact SHA");
  });

  it("fails closed when GitHub Actions proof is unavailable", async () => {
    await expect(runGate(proof(), { httpStatus: 503 })).rejects.toThrow(
      "GitHub Actions proof unavailable",
    );
  });
});
