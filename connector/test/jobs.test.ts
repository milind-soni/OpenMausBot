import { describe, expect, it } from "vitest";

import type { Home } from "../src/home.ts";
import { jobRunner } from "../src/jobs.ts";
import type { HostHealth, Job } from "../src/protocol.ts";

const HOME = `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${"a".repeat(64)}`;

function runner(overrides: Partial<Record<keyof Home, unknown>> = {}) {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const home = {
    refreshHealth: async () => { calls.push("refreshHealth"); return null; },
    copies: async () => ({ backups: [], snapshot: null }),
    report: async () => ({ state: "running", image: HOME, health: null }),
    update: (jobId: string, image: string) => new Promise((resolve) => {
      calls.push(`update ${jobId} ${image}`);
      pending.push(() => resolve({ home: { state: "running", image, health: null }, previousImage: null, snapshot: null }));
    }),
    stop: async () => { throw new Error("Docker is not running"); },
    ...overrides,
  } as unknown as Home;
  const run = jobRunner({
    home,
    hostHealth: async () => ({ arch: "x86_64" }) as HostHealth,
    identity: () => ({ version: "1.0.0", protocol: 1, image: null }),
    admin: () => ({ origin: "https://cloud.example.test", token: "t" }),
    selfUpdate: async (job) => ({ id: job.id, ok: true, result: { connector: { version: "1.0.0", protocol: 1, image: job.args.image } } }),
  });
  return { run, calls, pending };
}

describe("the jobs the connector runs", () => {
  it("answers status with a fresh health read, the copies and the connector, and host-health with the host", async () => {
    const { run, calls } = runner();
    expect(await run({ id: "s", type: "status", args: {} })).toEqual({
      id: "s", ok: true, result: { home: { state: "running", image: HOME, health: null }, connector: { version: "1.0.0", protocol: 1, image: null }, backups: [], snapshot: null },
    });
    expect(calls).toEqual(["refreshHealth"]);
    expect(await run({ id: "h", type: "host-health", args: {} })).toEqual({ id: "h", ok: true, result: { host: { arch: "x86_64" } } });
  });

  it("turns any failure into the job's error, and refuses more than eight waiting changes", async () => {
    const { run, pending } = runner();
    expect(await run({ id: "x", type: "stop", args: {} })).toEqual({ id: "x", ok: false, error: { code: "docker", message: "Docker is not running" } });
    const waiting = Array.from({ length: 8 }, (_, i) => run({ id: `u${i}`, type: "update", args: { image: HOME } } as Job));
    expect(await run({ id: "u9", type: "update", args: { image: HOME } })).toEqual({ id: "u9", ok: false, error: { code: "busy", message: "8 jobs are already waiting on this server; send this one again later." } });
    expect(await run({ id: "s", type: "status", args: {} })).toMatchObject({ ok: true });
    for (const release of pending) release();
    expect((await Promise.all(waiting)).every((reply) => reply?.ok)).toBe(true);
  });
});
