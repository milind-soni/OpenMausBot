import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { execCliTreeMock } = vi.hoisted(() => ({ execCliTreeMock: vi.fn() }));
vi.mock("./procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./procs.ts")>();
  return {
    ...actual,
    execCliTree: execCliTreeMock,
  };
});

const originalUserProfile = process.env.USERPROFILE;
const testProfileRoot = mkdtempSync(join(tmpdir(), "openmaus-antigravity-test-"));
process.env.USERPROFILE = testProfileRoot;

const {
  antigravityManagedQuotaRefreshRunning,
  antigravityManagedWorkerRunning,
  antigravityAccountStatuses,
  clearAntigravityQuotaCache,
  getAntigravityAccountEmail,
  getAntigravityProfileDir,
  getAntigravityProfileEnv,
  nextAntigravityQuotaStaleState,
  parseAntigravityUsage,
  profileForInstance,
  PROFILES,
  refreshAntigravityProfileQuota,
  registerManagedAntigravityWorker,
  unregisterManagedAntigravityWorker,
  withAntigravityAccountRefreshSingleFlight,
  withAntigravityCredentialLock,
  withManagedAntigravityQuotaRefresh,
  writeAntigravityAccountLabels,
} = await import("./antigravity-accounts.ts");

afterAll(() => {
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(testProfileRoot, { recursive: true, force: true });
});

beforeEach(() => {
  execCliTreeMock.mockReset();
  clearAntigravityQuotaCache();
});

describe("Antigravity account coordination & worker profiles", () => {
  it("defines Worker A and Worker B with required instance IDs and labels", () => {
    expect(PROFILES.a.instanceId).toBe("antigravity_worker_a");
    expect(PROFILES.a.label).toBe("Antigravity Worker A");
    expect(PROFILES.b.instanceId).toBe("antigravity_worker_b");
    expect(PROFILES.b.label).toBe("Antigravity Worker B");

    expect(profileForInstance("antigravity_worker_a")).toBe("a");
    expect(profileForInstance("antigravity_worker_b")).toBe("b");
    expect(profileForInstance("unknown")).toBeNull();
  });

  it("isolates profile home directory and environment", () => {
    const dirA = getAntigravityProfileDir("a");
    const dirB = getAntigravityProfileDir("b");

    expect(dirA).toContain(join(".openmausbot", "antigravity-profiles", "worker-a"));
    expect(dirB).toContain(join(".openmausbot", "antigravity-profiles", "worker-b"));
    expect(dirA).not.toBe(dirB);

    const envA = getAntigravityProfileEnv("a", { PATH: "foo" });
    expect(envA.USERPROFILE).toBe(dirA);
    expect(envA.HOME).toBe(dirA);
    expect(envA.PATH).toBe("foo");

    const envB = getAntigravityProfileEnv("b", { PATH: "bar" });
    expect(envB.USERPROFILE).toBe(dirB);
    expect(envB.HOME).toBe(dirB);
    expect(envB.PATH).toBe("bar");
  });

  it("reads account email labels from antigravity-account-labels.json", () => {
    expect(getAntigravityAccountEmail("a")).toBe("");
    expect(getAntigravityAccountEmail("b")).toBe("");

    writeAntigravityAccountLabels({ a: "account1@gmail.com", b: "account2@gmail.com" });

    expect(getAntigravityAccountEmail("a")).toBe("account1@gmail.com");
    expect(getAntigravityAccountEmail("b")).toBe("account2@gmail.com");
  });

  it("keeps a failed refresh stale across cache reads until a successful refresh", () => {
    const failed = nextAntigravityQuotaStaleState(false, "failure");
    const normalCacheRead = nextAntigravityQuotaStaleState(failed, "unchanged");
    const refreshed = nextAntigravityQuotaStaleState(normalCacheRead, "success");

    expect(failed).toBe(true);
    expect(normalCacheRead).toBe(true);
    expect(refreshed).toBe(false);
  });

  it("distinguishes OpenMaus-managed workers from standalone agy processes", () => {
    expect(antigravityManagedWorkerRunning()).toBe(false);
    registerManagedAntigravityWorker(12001);
    expect(antigravityManagedWorkerRunning()).toBe(true);
    registerManagedAntigravityWorker(12002);
    unregisterManagedAntigravityWorker(12001);
    expect(antigravityManagedWorkerRunning()).toBe(true);
    unregisterManagedAntigravityWorker(12002);
    expect(antigravityManagedWorkerRunning()).toBe(false);
  });

  it("parses the documented structured read-only usage response", () => {
    const quota = parseAntigravityUsage(
      JSON.stringify({
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  { id: "gemini-weekly", remaining_fraction: 0.82, reset_time: "2026-08-30T00:00:00Z" },
                  { id: "gemini-5h", remaining_fraction: 0.91, reset_time: "2026-08-24T00:00:00Z" },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  { id: "3p-weekly", remaining_fraction: 0.63, reset_time: "2026-08-30T00:00:00Z" },
                  { id: "3p-5h", remaining_fraction: 0.75, reset_time: "2026-08-24T00:00:00Z" },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(quota.gemini.weekly?.remaining).toBe(82);
    expect(quota.gemini.fiveHour?.remaining).toBe(91);
    expect(quota.other.weekly?.remaining).toBe(63);
    expect(quota.other.fiveHour?.remaining).toBe(75);
  });

  it("fails closed on incomplete or agent-turn payloads", () => {
    expect(() => parseAntigravityUsage(JSON.stringify({ groups: [] }))).toThrow("incomplete");
    expect(() =>
      parseAntigravityUsage(
        JSON.stringify({
          usage: { total_tokens: 1 },
          groups: [],
        }),
      ),
    ).toThrow("agent turn");
    expect(() => parseAntigravityUsage("invalid json")).toThrow("valid JSON");
  });

  it("shows that execCliTree settles on pipe closure, not a complete usage envelope", async () => {
    const { execCliTree: actualExecCliTree } =
      await vi.importActual<typeof import("./procs.ts")>("./procs.ts");
    const usageEnvelope = JSON.stringify({
      command: { name: "usage", data: { groups: [] } },
    });
    const childScript = [
      "const { spawn } = require('node:child_process');",
      `process.stdout.write(${JSON.stringify(usageEnvelope)});`,
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 1, 2] });",
      "setTimeout(() => {}, 5000);",
    ].join("\n");

    let error: unknown;
    try {
      await actualExecCliTree(process.execPath, ["-e", childScript], {
        timeout: 1_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("timed out after 1000ms");
    const capturedStdout = (error as Error & { stdout?: string }).stdout ?? "";
    expect(capturedStdout).toContain('"command"');
    expect(capturedStdout).toContain('"usage"');
  });

  it("preserves last-good quota and marks it stale after a bounded refresh failure", async () => {
    const output = JSON.stringify({
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", remaining_fraction: 0.84 },
                { id: "gemini-5h", remaining_fraction: 1 },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-weekly", remaining_fraction: 0.63 },
                { id: "3p-5h", remaining_fraction: 0.75 },
              ],
            },
          ],
        },
      },
    });

    execCliTreeMock.mockResolvedValueOnce({ stdout: output, stderr: "" });
    await refreshAntigravityProfileQuota("a");
    expect(execCliTreeMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/agy/i),
      ["--print", "/usage", "--output-format", "json"],
      expect.objectContaining({
        windowsHide: true,
        timeout: 30_000,
        env: expect.objectContaining({
          USERPROFILE: expect.stringContaining(join(".openmausbot", "antigravity-profiles", "worker-a")),
          HOME: expect.stringContaining(join(".openmausbot", "antigravity-profiles", "worker-a")),
        }),
        completionPredicate: expect.any(Function),
      }),
    );

    execCliTreeMock.mockRejectedValueOnce(new Error("bounded timeout"));
    await expect(refreshAntigravityProfileQuota("a")).rejects.toThrow("bounded timeout");
    const statuses = await antigravityAccountStatuses(false);
    const statusA = statuses.find((entry) => entry.profile === "a");
    expect(statusA?.quota.gemini.weekly?.remaining).toBe(84);
    expect(statusA?.quota.gemini.fiveHour?.remaining).toBe(100);
    expect(statusA?.quotaStale).toBe(true);
    expect(statusA?.instanceId).toBe("antigravity_worker_a");
    expect(statusA?.label).toBe("Antigravity Worker A");
    expect(statusA?.email).toBe("account1@gmail.com");
  });

  it("serializes machine-wide credential operations", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withAntigravityCredentialLock(async () => {
      events.push("a:start");
      await firstGate;
      events.push("a:end");
    });
    const second = withAntigravityCredentialLock(async () => {
      events.push("b:start");
      events.push("b:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["a:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("coalesces overlapping picker refreshes into one managed probe", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = () =>
      withManagedAntigravityQuotaRefresh(async () => {
        calls += 1;
        await gate;
        return [];
      });

    const first = withAntigravityAccountRefreshSingleFlight(operation);
    const second = withAntigravityAccountRefreshSingleFlight(operation);
    expect(first).toBe(second);
    expect(calls).toBe(1);
    expect(antigravityManagedQuotaRefreshRunning()).toBe(true);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(antigravityManagedQuotaRefreshRunning()).toBe(false);
  });
});
