import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuditLog, auditArgs, auditRequest, verifyAudit, type AuditLine } from "../src/audit.ts";
import { jobDesk } from "../src/jobs.ts";
import { localJobId, sendLocalJob, serveLocalJobs } from "../src/local.ts";
import { parsePolicy } from "../src/policy.ts";
import type { Job, JobReply } from "../src/protocol.ts";

const HOME = `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${"a".repeat(64)}`;
const SECRET = "Bootstrap-secret-0123456789abcdefghijklmnopq";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-connector-audit-"));
  dirs.push(dir);
  return dir;
};
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as AuditLine);

describe("the audit log", () => {
  it("appends one line per event, each linked to the one before it, root's alone", () => {
    const file = join(folder(), "log", "audit.jsonl");
    let clock = Date.parse("2026-11-06T02:00:00Z");
    const audit = new AuditLog(file, () => clock++);
    audit.append({ event: "connector", what: "started", version: "1.0.0", image: null });
    audit.append({ event: "job", by: "admin", id: "u1", type: "update", args: { image: HOME } });
    // Another process (a connector taking over from this one) appends to the same file: the chain still holds.
    new AuditLog(file).append({ event: "result", by: "admin", id: "u1", type: "update", ok: true, detail: { image: HOME } });
    const written = lines(file);
    expect(written.map((line) => [line.seq, line.event])).toEqual([[1, "connector"], [2, "job"], [3, "result"]]);
    expect(written[0]).toMatchObject({ at: "2026-11-06T02:00:00.000Z", prev: "0".repeat(64) });
    expect(verifyAudit(readFileSync(file, "utf8"))).toEqual({ ok: true, lines: 3 });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(audit.tail(2).map((line) => JSON.parse(line).seq)).toEqual([2, 3]);
  });

  it("shows a line changed or taken out", () => {
    const file = join(folder(), "audit.jsonl");
    const audit = new AuditLog(file);
    for (const id of ["a", "b", "c"]) audit.append({ event: "job", by: "local", id, type: "backup", args: {} });
    const text = readFileSync(file, "utf8").split("\n");
    expect(verifyAudit([text[0], text[2]].join("\n"))).toMatchObject({ ok: false, line: 2, why: "the line before it was changed or removed" });
    expect(verifyAudit([text[0].replace('"by":"local"', '"by":"admin"'), text[1], text[2]].join("\n"))).toMatchObject({ ok: false, line: 2 });
    expect(verifyAudit(text.slice(1).join("\n"))).toMatchObject({ ok: false, line: 1 });
    expect(verifyAudit("")).toEqual({ ok: true, lines: 0 });
  });

  it("records what a job asked for without a value that could be a secret", () => {
    const start: Job = { id: "s1", type: "start", args: { image: HOME, env: { OMB_PUBLIC_URL: "https://acme.example", OMB_CLOUD_BOOTSTRAP_SECRET: SECRET } } };
    expect(auditArgs(start)).toEqual({ image: HOME, env: ["OMB_CLOUD_BOOTSTRAP_SECRET", "OMB_PUBLIC_URL"] });
    expect(JSON.stringify(auditArgs(start))).not.toContain(SECRET);
    expect(auditArgs({ id: "i1", type: "import-disk", args: { url: "https://bucket.example/home.tar.gz?X-Signature=abcdef" } })).toEqual({ from: "https://bucket.example" });
    expect(auditArgs({ id: "r1", type: "restore", args: { backupId: "20261028-104512-3fa9" } })).toEqual({ backupId: "20261028-104512-3fa9" });
  });

  it("names who an Admin pairing is for and on which device, never the code or a query", () => {
    const body = JSON.stringify({ label: "Ana's laptop", ttlSeconds: 600, member: { email: "ana@example.test", role: "admin", sig: "x" } });
    expect(auditRequest("POST", "/api/cloud/pairing", 200, body)).toEqual({
      event: "request", by: "admin", method: "POST", path: "/api/cloud/pairing", status: 200, member: { email: "ana@example.test", role: "admin", device: "Ana's laptop" },
    });
    expect(auditRequest("GET", "/api/cloud/health?token=abc", 200, null)).toEqual({ event: "request", by: "admin", method: "GET", path: "/api/cloud/health", status: 200 });
    expect(auditRequest("POST", "/api/cloud/pairing", 400, "not json")).not.toHaveProperty("member");
  });
});

describe("the job desk", () => {
  const reply = (job: Job): JobReply => ({ id: job.id, ok: true, result: { home: { state: "running", image: HOME, health: null }, previousImage: null, snapshot: { id: "snapshot", kind: "snapshot", createdAt: 1, image: HOME } } } as JobReply);

  it("records each job and its result, whoever sent it", async () => {
    const file = join(folder(), "audit.jsonl");
    const ran: string[] = [];
    const desk = jobDesk({ run: async (job) => { ran.push(job.id); return reply(job); }, audit: new AuditLog(file), log: () => {} });
    await desk.submit({ id: "u1", type: "update", args: { image: HOME } }, "admin");
    await desk.submit({ id: "local-1", type: "restart", args: {} }, "local");
    expect(ran).toEqual(["u1", "local-1"]);
    expect(lines(file).map((line) => { const { event, by, id } = line as AuditLine & { by: string; id: string }; return { event, by, id }; })).toEqual([
      { event: "job", by: "admin", id: "u1" }, { event: "result", by: "admin", id: "u1" },
      { event: "job", by: "local", id: "local-1" }, { event: "result", by: "local", id: "local-1" },
    ]);
    expect(lines(file)[1]).toMatchObject({ ok: true, detail: { home: "running", image: HOME, copy: "snapshot" } });
  });

  it("does nothing that changes the server when it cannot record it, and still answers a status", async () => {
    const dir = folder();
    writeFileSync(join(dir, "log"), "a file where the folder should be");
    const logged: string[] = [];
    const ran: string[] = [];
    const desk = jobDesk({ run: async (job) => { ran.push(job.type); return reply(job); }, audit: new AuditLog(join(dir, "log", "audit.jsonl")), log: (line) => logged.push(line) });
    const refused = await desk.submit({ id: "u1", type: "update", args: { image: HOME } }, "admin");
    expect(refused).toMatchObject({ ok: false, error: { code: "audit_unavailable" } });
    expect((await desk.submit({ id: "s1", type: "status", args: {} }, "admin"))?.ok).toBe(true);
    expect(ran).toEqual(["status"]);
    expect(logged.some((line) => line.startsWith("could not write the audit log"))).toBe(true);
  });
});

describe("the server owner's policy", () => {
  const ran: string[] = [];
  const desk = (dir: string) => jobDesk({
    run: async (job) => { ran.push(`${job.type}`); return { id: job.id, ok: true, result: { home: { state: "running", image: HOME, health: null } } } as JobReply; },
    audit: new AuditLog(join(dir, "audit.jsonl")), log: () => {}, policyFile: join(dir, "policy.json"),
  });
  const SELF = { id: "self-1", type: "self-update", args: { image: `ghcr.io/milind-soni/mausbot-connector@sha256:${"b".repeat(64)}` } } as Job;
  const UPDATE = { id: "u1", type: "update", args: { image: HOME } } as Job;

  it("limits what MausBot may run here, records each refusal, and never limits root on the server or a self-update", async () => {
    const dir = folder();
    ran.splice(0);
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ jobs: ["status", "backup"], updates: "hold" }));
    const refused = await desk(dir).submit(UPDATE, "admin");
    expect(refused).toEqual({ id: "u1", ok: false, error: { code: "refused_by_policy", message: `This server's policy ${join(dir, "policy.json")} does not let MausBot run update jobs.` } });
    expect((await desk(dir).submit(SELF, "admin"))?.ok).toBe(true);
    expect((await desk(dir).submit({ ...UPDATE, id: "local-1" }, "local"))?.ok).toBe(true);
    expect(ran).toEqual(["self-update", "update"]);
    expect(lines(join(dir, "audit.jsonl")).filter((line) => line.event === "result").map((line) => (line as { error?: { code: string } }).error?.code ?? "ok")).toEqual(["refused_by_policy", "ok", "ok"]);
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ updates: "hold" }));
    expect(await desk(dir).submit(UPDATE, "admin")).toMatchObject({ error: { code: "refused_by_policy", message: expect.stringContaining("holds updates") } });
    expect((await desk(dir).submit({ id: "b1", type: "backup", args: {} }, "admin"))?.ok).toBe(true);
  });

  it("changes nothing for MausBot while the policy cannot be used, but still answers a status and takes a self-update", async () => {
    const dir = folder();
    ran.splice(0);
    writeFileSync(join(dir, "policy.json"), '{"updates": "sometimes"}');
    expect(await desk(dir).submit(UPDATE, "admin")).toMatchObject({ error: { code: "refused_by_policy", message: expect.stringContaining('"updates" must be "automatic" or "hold"') } });
    expect((await desk(dir).submit({ id: "s1", type: "status", args: {} }, "admin"))?.ok).toBe(true);
    expect((await desk(dir).submit(SELF, "admin"))?.ok).toBe(true);
    expect(ran).toEqual(["status", "self-update"]);
    expect(parsePolicy(null)).toEqual({ ok: true, policy: { jobs: null, updates: "automatic" } });
    expect(parsePolicy('{"jobs": ["shell"]}')).toMatchObject({ ok: false });
    expect(parsePolicy('{"support": "always"}')).toEqual({ ok: false, problem: "it has a setting this connector does not know: support" });
    expect(parsePolicy("[]")).toMatchObject({ ok: false });
  });
});

describe.skipIf(process.platform === "win32")("jobs from root on this server", () => {
  it("go through the same checks and desk as MausBot's, and only root can reach the socket", async () => {
    const dir = folder();
    const socket = join(dir, "jobs.sock");
    const submitted: { job: Job; by: string }[] = [];
    const server = await serveLocalJobs(socket, { submit: async (job, by) => { submitted.push({ job, by }); return reply(job); } }, () => {});
    try {
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      const answered = await sendLocalJob(socket, "update", { image: HOME });
      expect(answered).toMatchObject({ ok: true, result: { home: { image: HOME } } });
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({ by: "local", job: { type: "update", args: { image: HOME } } });
      expect(submitted[0]!.job.id).toMatch(/^local-\d{14}-[0-9a-f]{6}$/);
      expect(await sendLocalJob(socket, "shell", { command: "id" })).toMatchObject({ ok: false, error: { code: "unknown_job" } });
      expect(await sendLocalJob(socket, "update", { image: "docker.io/someone/else:latest" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      expect(submitted).toHaveLength(1);
    } finally {
      server.close();
    }
    await expect(sendLocalJob(socket, "status", {})).rejects.toThrow("the connector is not running here");
    expect(localJobId()).not.toBe(localJobId());
  });

  function reply(job: Job): JobReply {
    return { id: job.id, ok: true, result: { home: { state: "running", image: HOME, health: null }, previousImage: null, snapshot: null } } as JobReply;
  }
});
