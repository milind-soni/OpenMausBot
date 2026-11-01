import { afterEach, describe, expect, it } from "vitest";

import { Agent, backoffMs, connectUrl } from "../src/agent.ts";
import { adminOrigin, enroll } from "../src/enroll.ts";
import { CLOSE_UNAUTHORIZED, type HostFacts, type Job, type JobReply } from "../src/protocol.ts";
import type { StatusRecord } from "../src/state.ts";
import { FakeAdmin } from "./fake-admin.ts";

const host: HostFacts = { os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0", arch: "x86_64", cpus: 4, memMb: 16_000, diskGb: 120, docker: "28.0.4", apparmor: true, userns: true };
const connector = { version: "1.0.0", protocol: 1 as const, image: null };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connected(options: { handle?: (job: Job) => Promise<JobReply | null>; setTimer?: (callback: () => void, ms: number) => unknown } = {}) {
  const admin = new FakeAdmin();
  const origin = await admin.listen();
  cleanups.push(() => admin.close());
  const record = await enroll({ admin: origin, code: admin.mintCode(), host, connector });
  const handled: Job[] = [];
  const statuses: Partial<StatusRecord>[] = [];
  const lines: string[] = [];
  const agent = new Agent({
    admin: origin, token: record.agentToken, log: (line) => lines.push(line), heartbeatMs: 100, random: () => 0,
    heartbeat: async () => ({ heartbeat: { host: { ...host, diskTotalGb: 200, memAvailableMb: 9000, load1: 0.1, uptimeS: 50, clockSkewS: 0, checks: [] }, home: { state: "running", image: null, health: null }, connector } }),
    handle: options.handle ?? (async (job) => {
      handled.push(job);
      return { id: job.id, ok: true, result: { host: { ...host } } } as unknown as JobReply;
    }),
    status: (patch) => statuses.push(patch),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
  });
  cleanups.push(() => agent.stop());
  agent.start();
  await until(() => admin.connected);
  return { admin, origin, record, agent, handled, statuses, lines };
}

describe("the connector's connection to MausBot", () => {
  it("enrols once with the one-time code, then connects with its own token and sends a heartbeat every interval", async () => {
    const { admin, record, statuses, lines } = await connected();
    const [server] = admin.servers.values();
    expect(server).toMatchObject({ serverId: record.serverId, cloudId: record.cloudId, token: record.agentToken, enroll: { host, connector } });
    expect(record).toMatchObject({ version: 1, admin: admin.origin });
    await until(() => admin.heartbeats.length >= 3);
    expect(admin.heartbeats[0]).toMatchObject({ home: { state: "running" }, connector: { protocol: 1 }, host: { arch: "x86_64" } });
    expect(statuses).toContainEqual(expect.objectContaining({ connected: true, unauthorized: false }));
    expect(admin.connections).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(record.agentToken);
    await expect(enroll({ admin: admin.origin, code: [...admin.codes][0] ?? "MB-USED-CODE", host, connector })).rejects.toThrow(
      "This code isn't valid anymore: a code works once, for one hour. Make a new one in MausBot and run the install command again.");
  });

  it("answers each job once: the same id again gets the same reply, and never a second run", async () => {
    const { admin, handled } = await connected();
    const first = await admin.job("host-health", {}, "job-1");
    expect(first).toMatchObject({ id: "job-1", ok: true });
    const again = await admin.job("host-health", {}, "job-1");
    expect(again).toEqual(first);
    expect(handled.map((job) => job.id)).toEqual(["job-1"]);
  });

  it("refuses a malformed job by its id, and ignores what has no id or is not JSON", async () => {
    const { admin, handled, lines } = await connected();
    expect(await admin.job("shell" as "status", { command: "id" }, "job-2")).toEqual({ id: "job-2", ok: false, error: { code: "unknown_job", message: 'unknown job type "shell"' } });
    expect(await admin.job("restore", { backupId: "../../etc" }, "job-3")).toMatchObject({ id: "job-3", ok: false, error: { code: "invalid_args" } });
    admin.send({ type: "status" });
    admin.send("not json");
    await until(() => lines.some((line) => line.includes("not JSON")));
    expect(lines).toContain("ignored a job without a valid id: a job needs an id of 1 to 64 letters, digits, - or _");
    expect(handled).toEqual([]);
  });

  it("keeps a reply made while the connection is down, comes back with backoff, and delivers it", async () => {
    let finish: (reply: JobReply) => void = () => {};
    const { admin } = await connected({ handle: (job) => new Promise((resolve) => { finish = resolve; void job; }) });
    admin.send({ id: "slow-1", type: "update", args: { image: `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${"b".repeat(64)}` } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    admin.drop();
    await until(() => !admin.connected);
    finish({ id: "slow-1", ok: false, error: { code: "update_rolled_back", message: "rolled back", image: "x" } });
    const reply = await admin.replyTo("slow-1", 5_000);
    expect(reply).toMatchObject({ id: "slow-1", ok: false, error: { code: "update_rolled_back" } });
    expect(admin.connections).toHaveLength(2);
    // Acknowledged: a later connection does not bring it again.
    const count = admin.replyCounts.get("slow-1");
    admin.drop();
    await until(() => admin.connections.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(admin.replyCounts.get("slow-1")).toBe(count);
    expect(backoffMs(0, 0)).toBe(500);
    expect(backoffMs(3, 1)).toBe(12_000);
    expect(backoffMs(20, 0.5)).toBe(60_000);
  });

  it("slows right down when MausBot no longer knows its token, and says so", async () => {
    const waits: number[] = [];
    const { admin, record, statuses, lines } = await connected({
      setTimer: (callback, ms) => {
        waits.push(ms);
        return ms < 1000 ? setTimeout(callback, ms) : setTimeout(() => {}, 0);
      },
    });
    admin.revoked.add(record.agentToken);
    admin.drop();
    await until(() => statuses.some((patch) => patch.unauthorized === true));
    expect(waits).toContain(5 * 60_000);
    expect(lines).toContain("MausBot no longer knows this server; run the install command again with a new code to connect it");
    expect(CLOSE_UNAUTHORIZED).toBe(4401);
  });

  it("connects to the Admin's own origin over wss, and to a test Admin on loopback over ws only", () => {
    expect(connectUrl("https://cloud.openmausbot.com")).toBe("wss://cloud.openmausbot.com/api/cloud/servers/agent/connect");
    expect(connectUrl("http://127.0.0.1:9000")).toBe("ws://127.0.0.1:9000/api/cloud/servers/agent/connect");
    expect(adminOrigin("https://cloud.openmausbot.com/")).toBe("https://cloud.openmausbot.com");
    expect(adminOrigin("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
    for (const bad of ["http://cloud.openmausbot.com", "https://user:pw@cloud.openmausbot.com", "ftp://x", undefined]) expect(() => adminOrigin(bad)).toThrow();
  });

  it("says plainly when MausBot cannot be reached at enrolment", async () => {
    await expect(enroll({ admin: "http://127.0.0.1:9", code: "MB-1A2B-3C4D", host, connector })).rejects.toThrow(/^This server can't reach MausBot at http:\/\/127\.0\.0\.1:9 /);
    await expect(enroll({ admin: "http://127.0.0.1:9", code: "MB 1A2B", host, connector })).rejects.toThrow("the code is the one-time code MausBot shows next to the install command");
  });
});
