import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AdoptedHome, UPDATE_FILES, enrolmentRefusal, findInstall, standaloneServerPresent } from "../src/adopted-home.ts";
import { Agent, type Refusal } from "../src/agent.ts";
import { AuditLog, type AuditEvent, type AuditLine } from "../src/audit.ts";
import { serveCustomerRunRequest } from "../src/customer-run-requests.ts";
import {
  CUSTOMER_RUN_JOBS, CUSTOMER_RUN_REQUESTS, HOME_READS, HOME_READS_COMMAND, checkCustomerRunJob, customerRunRefusal, parseHomeReads, reducedHeartbeat, reducedReply,
} from "../src/customer-run.ts";
import { enroll } from "../src/enroll.ts";
import { jobDesk, jobRunner } from "../src/jobs.ts";
import { parsePolicy, policyRefusal } from "../src/policy.ts";
import { JOB_TYPES, checkJob, type HostFacts, type HostHealth, type Job, type JobReply, type JobType } from "../src/protocol.ts";
import { StateStore, type AgentRecord } from "../src/state.ts";
import { FakeAdmin } from "./fake-admin.ts";
import { FakeDocker } from "./fake-docker.ts";

const digest = (letter: string) => `ghcr.io/milind-soni/openmausbot@sha256:${letter.repeat(64)}`;
const CLOUD_HOME = `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${"c".repeat(64)}`;
const CONNECTOR = `ghcr.io/milind-soni/mausbot-connector@sha256:${"1".repeat(64)}`;
const RUNNING = "ghcr.io/milind-soni/openmausbot:v0.1.151";
const NEXT = digest("b");
const EMAIL = "ada.lovelace@customer.example";
const WRITTEN = "Quarterly numbers for Project Nightingale";
const SERVER_NAME = "Lovelace Analytical Engines";
const host: HostFacts = { os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-1021-azure", arch: "x86_64", cpus: 4, memMb: 16_000, diskGb: 120, docker: "28.0.4", apparmor: true, userns: true };
const health: HostHealth = {
  ...host, diskTotalGb: 200, memAvailableMb: 9000, load1: 0.1, uptimeS: 50, clockSkewS: 0,
  checks: [{ id: "disk", ok: true, warning: true, fix: `Your server's disk is 90% full, ${EMAIL} said so.` }, { id: "clock", ok: true }],
};
const identity = { version: "1.0.0", protocol: 2 as const, image: CONNECTOR };

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

/** A server its owner installed with deploy/install.sh: the Compose project, its data folder, and a home that answers on its own loopback. */
function server(options: { image?: string; seats?: number | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-customer-run-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "opt-openmausbot", "data");
  const updateDir = join(dir, "update");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(updateDir);
  const state = new StateStore(join(dir, "state"));
  const docker = new FakeDocker(state.dir);
  let clock = 1_800_000_000_000;
  docker.now = () => clock;
  const image = options.image ?? RUNNING;
  for (const ref of [image, NEXT, "caddy:2"]) {
    docker.publish(ref, null);
    docker.images.set(ref, {});
  }
  const compose = (service: string) => ({ "com.docker.compose.project": "openmausbot", "com.docker.compose.service": service });
  const home = { answers: true, seats: options.seats === undefined ? 7 : options.seats, execs: [] as string[][] };
  docker.onExec = (_container, command) => {
    home.execs.push(command);
    if (!home.answers) return { code: 0, output: "\n\u001e\n\n\u001e\n\n\u001e\n" };
    return {
      code: 0,
      output: [
        JSON.stringify({ app: "openmausbot", pid: 41, owner: EMAIL }),
        JSON.stringify({ environmentId: "env-1", label: SERVER_NAME, version: "0.1.151", admin: EMAIL }),
        home.seats === null ? JSON.stringify({ error: "Not found" }) : JSON.stringify({ seats: home.seats, people: [EMAIL] }),
      ].map((answer) => `${answer}\n\u001e\n`).join(""),
    };
  };
  const steps: string[] = [];
  const lines: string[] = [];
  const adopted = new AdoptedHome({
    docker, state, log: (line) => lines.push(line), diskFree: () => 500e9, updateDir,
    now: () => clock, sleep: async (ms) => { clock += ms; }, startWindowMs: 60_000, updateDeadlineMs: 120_000, pollMs: 2_000,
    onStep: ({ id, step }) => steps.push(`${id} ${step}`),
  });
  const install = async () => {
    await docker.createContainer("openmausbot-omb-1", { Image: image, Labels: compose("omb"), HostConfig: { Mounts: [{ Type: "bind", Source: dataDir, Target: "/data" }] } });
    await docker.createContainer("openmausbot-caddy-1", { Image: "caddy:2", Labels: compose("caddy"), HostConfig: { NetworkMode: "container:omb" } });
    await docker.startContainer("openmausbot-omb-1");
    await docker.startContainer("openmausbot-caddy-1");
    docker.folder(dataDir).files.set("chats.json", WRITTEN);
    docker.calls.length = 0;
  };
  return { dir, dataDir, updateDir, state, docker, adopted, home, steps, lines, install, image };
}

function desk(fixture: ReturnType<typeof server>, options: { mode?: "customer-run" | "operated"; paused?: () => boolean } = {}) {
  const ran: Job[] = [];
  const audit = new AuditLog(join(fixture.dir, "audit.jsonl"));
  const run = jobRunner({
    adopted: fixture.adopted, hostHealth: async () => health, identity: () => identity,
    admin: () => ({ origin: "https://cloud.example.test", authorization: () => "Box token" }),
    selfUpdate: async (job) => ({ id: job.id, ok: true, result: { connector: identity } }),
  });
  const made = jobDesk({ run: async (job) => { ran.push(job); return run(job); }, audit, log: () => {}, mode: options.mode ?? "customer-run", paused: options.paused });
  const lines = () => audit.tail(100).map((line) => JSON.parse(line) as AuditLine);
  return { desk: made, ran, lines };
}

describe("a customer-run server: the jobs MausBot may run", () => {
  it("lists nine kinds, and neither of the two that move the data", () => {
    expect([...CUSTOMER_RUN_JOBS].sort()).toEqual(["backup", "host-health", "restart", "restore", "self-update", "start", "status", "stop", "update"]);
    expect(JOB_TYPES.filter((type) => customerRunRefusal(type) !== null)).toEqual(["export-disk", "import-disk"]);
  });

  it("refuses export-disk, import-disk and any kind it does not list as the job arrives, while the operated check still takes them", () => {
    const moved: [JobType, Record<string, unknown>][] = [["export-disk", {}], ["import-disk", { url: "https://storage.example.test/disk.tar.gz" }]];
    for (const [type, args] of moved) {
      expect(checkJob({ id: "j1", type, args })).toMatchObject({ ok: true });
      expect(checkCustomerRunJob({ id: "j1", type, args })).toEqual({
        ok: false, id: "j1", code: "refused_by_mode", message: `This server is run by its owner, and "${type}" is not a job MausBot may run on it.`,
      });
    }
    expect(checkCustomerRunJob({ id: "j2", type: "shell", args: { command: "cat /data" } })).toMatchObject({ ok: false, code: "refused_by_mode" });
  });

  it("refuses a start that names an image or settings, and an update to anything but MausBot's server image by digest", () => {
    const env = { OMB_CLOUD_ROLE: "team", OMB_CLOUD_MACHINE_ID: "m", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test", OMB_PUBLIC_URL: "https://acme.example.test", OMB_CLOUD_BOOTSTRAP_SECRET: "s".repeat(40) };
    expect(checkJob({ id: "s1", type: "start", args: { image: CLOUD_HOME, env } })).toMatchObject({ ok: true });
    expect(checkCustomerRunJob({ id: "s1", type: "start", args: { image: CLOUD_HOME, env } })).toMatchObject({ ok: false, id: "s1", code: "refused_by_mode" });
    expect(checkCustomerRunJob({ id: "s2", type: "start" })).toEqual({ ok: true, job: { id: "s2", type: "start", args: {} } });
    expect(checkCustomerRunJob({ id: "u1", type: "update", args: { image: NEXT } })).toEqual({ ok: true, job: { id: "u1", type: "update", args: { image: NEXT } } });
    for (const image of [CLOUD_HOME, RUNNING, "ghcr.io/someone-else/openmausbot@sha256:" + "a".repeat(64)]) {
      expect(checkCustomerRunJob({ id: "u2", type: "update", args: { image } }), image).toMatchObject({ ok: false, code: "invalid_args" });
    }
    expect(checkCustomerRunJob({ id: "u3", type: "update", args: { image: NEXT, env } })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(checkCustomerRunJob({ id: "bad id", type: "start" })).toMatchObject({ ok: false, id: null, code: "invalid_job" });
    expect(checkCustomerRunJob({ id: "r1", type: "restore", args: { backupId: "../etc" } })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("refuses them again at the desk, whoever sent them, runs nothing, and writes both the job and the refusal to the audit log", async () => {
    const fixture = server();
    await fixture.install();
    const { desk: made, ran, lines } = desk(fixture);
    for (const by of ["admin", "local"] as const) {
      for (const type of ["export-disk", "import-disk"] as const) {
        const reply = await made.submit({ id: `${by}-${type}`, type, args: type === "import-disk" ? { url: "https://storage.example.test/disk.tar.gz" } : {} } as Job, by);
        expect(reply).toMatchObject({ ok: false, error: { code: "refused_by_mode" } });
      }
    }
    expect(ran).toEqual([]);
    expect(fixture.docker.calls).toEqual([]);
    expect(lines().map((line) => `${line.event} ${(line as { id?: string }).id}`)).toEqual([
      "job admin-export-disk", "result admin-export-disk", "job admin-import-disk", "result admin-import-disk",
      "job local-export-disk", "result local-export-disk", "job local-import-disk", "result local-import-disk",
    ]);
    const operated = desk(fixture, { mode: "operated" });
    await operated.desk.submit({ id: "x", type: "export-disk", args: {} }, "admin");
    expect(operated.ran.map((job) => job.type)).toEqual(["export-disk"]);
  });

  it("has no way to run them even past both checks: the home it attached to refuses the kind", async () => {
    const fixture = server();
    await fixture.install();
    const run = jobRunner({
      adopted: fixture.adopted, hostHealth: async () => health, identity: () => identity,
      admin: () => ({ origin: "https://cloud.example.test", authorization: () => "Box token" }),
      selfUpdate: async (job) => ({ id: job.id, ok: true, result: { connector: identity } }),
    });
    expect(await run({ id: "e", type: "export-disk", args: {} })).toMatchObject({ ok: false, error: { code: "refused_by_mode" } });
    expect(await run({ id: "i", type: "import-disk", args: { url: "https://storage.example.test/disk.tar.gz" } })).toMatchObject({ ok: false, error: { code: "refused_by_mode" } });
    expect(fixture.docker.calls).toEqual([]);
  });
});

describe("a customer-run server: pausing remote management", () => {
  it("refuses every job from MausBot while paused, the connector's own update too, logs each, and still runs the admin's own", async () => {
    const fixture = server();
    await fixture.install();
    let paused = true;
    const { desk: made, ran, lines } = desk(fixture, { paused: () => paused });
    for (const type of ["status", "stop", "self-update"] as const) {
      const job = { id: `p-${type}`, type, args: type === "self-update" ? { image: CONNECTOR } : {} } as Job;
      expect(await made.submit(job, "admin")).toMatchObject({ ok: false, error: { code: "paused" } });
    }
    expect(ran).toEqual([]);
    expect(lines().filter((line) => line.event === "result").map((line) => (line as { error?: { code: string } }).error?.code)).toEqual(["paused", "paused", "paused"]);
    expect(await made.submit({ id: "mine", type: "status", args: {} }, "local")).toMatchObject({ ok: true });
    paused = false;
    expect(await made.submit({ id: "after", type: "status", args: {} }, "admin")).toMatchObject({ ok: true });
  });

  it("lets the owner's policy file keep the connector they read: its job list covers the connector's own update here, and only here", () => {
    const update = { id: "c1", type: "self-update", args: { image: CONNECTOR } } as Job;
    const listed = parsePolicy('{"jobs":["status","host-health"]}');
    expect(policyRefusal(update, listed, "/etc/mausbot/policy.json", "customer-run")).toBe("This server's policy /etc/mausbot/policy.json does not let MausBot run self-update jobs.");
    expect(policyRefusal(update, listed, "/etc/mausbot/policy.json")).toBeNull();
    expect(policyRefusal(update, parsePolicy(null), "/etc/mausbot/policy.json", "customer-run")).toBeNull();
    expect(policyRefusal(update, parsePolicy('{"jobs":["self-update"]}'), "/etc/mausbot/policy.json", "customer-run")).toBeNull();
  });

  it("is kept on the server's disk, where the running connector reads it before each job", () => {
    const { state } = server();
    expect(state.paused()).toBe(false);
    state.savePause(true);
    expect(new StateStore(state.dir).paused()).toBe(true);
    state.savePause(false);
    expect(state.paused()).toBe(false);
  });
});

describe("a customer-run server: what leaves it", () => {
  const TOLD = /^(?:v?\d+\.\d+\.\d+|ghcr\.io\/milind-soni\/[a-z-]+[@:][\w.:-]+|Ubuntu 24\.04\.3 LTS|6\.8\.0-1021-azure|x86_64|28\.0\.4|customer-run|running|stopped|starting|updating|absent|[a-z]+|\d{8}-\d{6}-[0-9a-f]{4})$/;
  const strings = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) strings(item, out);
    else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) strings(item, out);
    return out;
  };

  it("reads three fields from the home and drops everything else it answered", () => {
    const fixture = server();
    expect(HOME_READS).toEqual(["/api/health", "/.well-known/openmausbot/environment", "/api/seats"]);
    const facts = parseHomeReads(fixture.docker.onExec!({} as never, []).output);
    expect(facts).toEqual({ answers: true, version: "0.1.151", seats: 7 });
    expect(parseHomeReads("not json\n\u001e\n{\"version\":\"<script>\"}\n\u001e\n{\"seats\":\"seven\"}\n\u001e\n")).toEqual({ answers: false, version: null, seats: null });
    expect(parseHomeReads("")).toEqual({ answers: false, version: null, seats: null });
  });

  it("sends a heartbeat of versions, states, counts and the seat count, with no address, name or sentence in it", async () => {
    const fixture = server();
    await fixture.install();
    await fixture.adopted.refreshHealth();
    expect(fixture.home.execs).toEqual([[...HOME_READS_COMMAND]]);
    const beat = reducedHeartbeat({ host: health, home: await fixture.adopted.report(), connector: identity, paused: false, seats: fixture.adopted.seats });
    const sent = JSON.stringify(beat);
    for (const secret of [EMAIL, "@customer", "lovelace", SERVER_NAME, "Lovelace", WRITTEN, "said so", "env-1"]) expect(sent, secret).not.toContain(secret);
    expect(beat.heartbeat).toEqual({
      host: { ...host, diskTotalGb: 200, memAvailableMb: 9000, load1: 0.1, uptimeS: 50, clockSkewS: 0, checks: [{ id: "disk", ok: true, warning: true }, { id: "clock", ok: true }] },
      home: { state: "running", image: RUNNING, health: { ok: true, version: "0.1.151", image: RUNNING, box: null, at: 1_800_000_000_000 } },
      connector: identity, mode: "customer-run", paused: false, seats: 7,
    });
    for (const text of strings(beat)) expect(text, text).toMatch(TOLD);
  });

  it("replaces anything that is not a version, an image or a machine's own name before it is sent", () => {
    const beat = reducedHeartbeat({
      host: { ...health, os: `Ubuntu (${EMAIL})`, kernel: "6.8.0\nBcc: someone", checks: [{ id: "notes" as never, ok: false, fix: WRITTEN }] },
      home: { state: WRITTEN as never, image: `registry.example/${EMAIL}`, health: { ok: true, version: WRITTEN, image: null, box: { box: EMAIL, checks: WRITTEN, failed: [EMAIL] }, at: 1 } },
      connector: { version: WRITTEN, protocol: 2, image: EMAIL }, paused: true, seats: 7.5,
    });
    expect(beat.heartbeat).toMatchObject({
      host: { os: "unknown", kernel: "unknown", checks: [] }, home: { state: "absent", image: null, health: { version: null, box: null } },
      connector: { version: "0.0.0", image: null }, paused: true, seats: null,
    });
    expect(JSON.stringify(beat)).not.toMatch(/@|Nightingale|Bcc/);
  });

  it("answers a failed job with its code and a fixed sentence: what Docker or the home said stays in the audit log", () => {
    const failed = reducedReply({ id: "j", ok: false, error: { code: "unhealthy", message: `The home stopped: startup failed: could not open ${EMAIL}'s chat "${WRITTEN}"`, image: RUNNING } });
    expect(failed).toEqual({ id: "j", ok: false, error: { code: "unhealthy", message: "The server did not become healthy. The server's admin can read the reason with: mausbot-connector audit", image: RUNNING } });
    const odd = reducedReply({ id: "j", ok: false, error: { code: WRITTEN as never, message: EMAIL, image: EMAIL } });
    expect(odd).toMatchObject({ error: { code: "docker" } });
    expect(JSON.stringify([failed, odd])).not.toMatch(/@|Nightingale/);
  });

  it("answers a job that worked with the fields it lists and nothing else the job produced", () => {
    const reply = reducedReply({
      id: "s", ok: true,
      result: {
        home: { state: "running", image: RUNNING, health: null, owner: EMAIL }, connector: identity, backups: [{ id: "20261028-104512-3fa9", kind: "backup", createdAt: 5, image: RUNNING, note: WRITTEN }],
        snapshot: null, members: [EMAIL], bytes: 12, sha256: "0".repeat(64),
      },
    } as unknown as JobReply);
    expect(reply).toEqual({
      id: "s", ok: true,
      result: { home: { state: "running", image: RUNNING, health: null }, connector: identity, backups: [{ id: "20261028-104512-3fa9", kind: "backup", createdAt: 5, image: RUNNING }], snapshot: null },
    });
  });
});

describe("a customer-run server: the home its owner installed", () => {
  it("attaches to the Compose install, and says in plain words why it cannot when there is none or it was built here", async () => {
    const fixture = server();
    expect(await standaloneServerPresent(fixture.docker)).toBe(false);
    expect(await findInstall(fixture.docker)).toEqual({ ok: false, why: "MausBot is not installed on this server yet. Install it first with the server's install command, then connect it." });
    await fixture.install();
    expect(await standaloneServerPresent(fixture.docker)).toBe(true);
    expect(await findInstall(fixture.docker)).toMatchObject({ ok: true, install: { dataDir: fixture.dataDir } });
    const built = server({ image: "deploy-omb" });
    await built.install();
    expect(await findInstall(built.docker)).toMatchObject({ ok: false, why: expect.stringContaining("was built here") });
  });

  it("will not be enrolled as a server MausBot runs where its owner's MausBot is already installed: that would start a second one", async () => {
    const fixture = server();
    expect(await enrolmentRefusal("operated", fixture.docker)).toBeNull();
    expect(await enrolmentRefusal("customer-run", fixture.docker)).toContain("MausBot is not installed on this server yet.");
    await fixture.install();
    expect(await enrolmentRefusal("operated", fixture.docker)).toBe(
      "MausBot already runs on this server, installed by its owner. Connecting it this way would start a second MausBot beside it. Run the install command again and it connects the one that is here, keeping its data.",
    );
    expect(await enrolmentRefusal("customer-run", fixture.docker)).toBeNull();
  });

  it("stops Caddy before the home and starts it after the home answers, and never makes, removes or renames a container", async () => {
    const fixture = server();
    await fixture.install();
    expect(await fixture.adopted.stop()).toEqual({ home: { state: "stopped", image: RUNNING, health: null } });
    expect(fixture.docker.calls).toEqual(["stop openmausbot-caddy-1", "stop openmausbot-omb-1"]);
    fixture.docker.calls.length = 0;
    expect(await fixture.adopted.start()).toMatchObject({ home: { state: "running", health: { ok: true, version: "0.1.151" } } });
    expect(fixture.docker.calls).toEqual(["start openmausbot-omb-1", "exec openmausbot-omb-1", "start openmausbot-caddy-1"]);
    fixture.docker.calls.length = 0;
    await fixture.adopted.restart();
    expect(fixture.docker.calls.filter((call) => /^(create|rm|rename|pull|rmi) /.test(call))).toEqual([]);
    expect(fixture.docker.container("mausbot-home")).toBeNull();
    expect(fixture.docker.volumes.has("mausbot-data")).toBe(false);
  });

  it("says the home did not answer when it does not, within the wait", async () => {
    const fixture = server();
    await fixture.install();
    await fixture.adopted.stop();
    fixture.home.answers = false;
    await expect(fixture.adopted.start()).rejects.toMatchObject({ code: "unhealthy", message: "The home did not answer within 1 minutes." });
    expect((await fixture.adopted.report()).state).toBe("starting");
  });

  it("backs the data folder up to a volume on the same server and puts a backup back, with a safety copy first", async () => {
    const fixture = server();
    await fixture.install();
    const { backup } = await fixture.adopted.backup("b1");
    expect(fixture.docker.files(`mausbot-backup-${backup.id}`)).toEqual({ "chats.json": WRITTEN });
    expect(fixture.docker.container("openmausbot-omb-1")?.status).toBe("running");
    fixture.docker.folder(fixture.dataDir).files.set("chats.json", "changed since");
    fixture.docker.folder(fixture.dataDir).files.set("new.json", "made since");
    expect(await fixture.adopted.restore("r1", backup.id)).toMatchObject({ backupId: backup.id, home: { state: "running" } });
    expect(Object.fromEntries(fixture.docker.folder(fixture.dataDir).files)).toEqual({ "chats.json": WRITTEN });
    expect(fixture.docker.files("mausbot-snapshot")).toEqual({ "chats.json": "changed since", "new.json": "made since" });
    expect(fixture.steps).toEqual(["b1 stop", "b1 copy", "r1 stop", "r1 snapshot", "r1 copy", "r1 start"]);
    expect(fixture.state.home().operation).toBeNull();
    await expect(fixture.adopted.restore("r2", "20200101-000000-aaaa")).rejects.toMatchObject({ code: "not_found" });
  });

  it("puts the data back as it was when the connector restarts in the middle of a restore", async () => {
    const fixture = server();
    await fixture.install();
    const { backup } = await fixture.adopted.backup("b1");
    const before = { "chats.json": "the newest chats" };
    fixture.docker.folder(fixture.dataDir).files.set("chats.json", before["chats.json"]);
    await fixture.docker.createVolume("mausbot-snapshot", { "com.mausbot.role": "snapshot" });
    fixture.docker.volume("mausbot-snapshot").files.set("chats.json", before["chats.json"]);
    fixture.docker.folder(fixture.dataDir).files.clear();
    fixture.state.saveHome({ ...fixture.state.home(), operation: { jobId: "r9", type: "restore", phase: "copy", previousImage: RUNNING, nextImage: null, target: `mausbot-backup-${backup.id}`, dataAtRisk: true, wasRunning: true, startedAt: 1 } });
    expect(await fixture.adopted.recover()).toEqual({ id: "r9", ok: false, error: { code: "interrupted", message: "The connector restarted during this restore; the data was put back as it was before, and the home was started again." } });
    expect(Object.fromEntries(fixture.docker.folder(fixture.dataDir).files)).toEqual(before);
    expect(fixture.docker.container("openmausbot-omb-1")?.status).toBe("running");
  });
});

describe("a customer-run server: updates go to the server's own updater", () => {
  /** Stands in for mausbot-update-runner.sh: reads the request the connector left and answers with update.sh's exit code. */
  const updater = (fixture: ReturnType<typeof server>, code: number, seen: string[] = []) => {
    writeFileSync(join(fixture.updateDir, UPDATE_FILES.runner), "1\n");
    const sleep = (fixture.adopted as unknown as { sleep: (ms: number) => Promise<void> }).sleep;
    (fixture.adopted as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
      const request = join(fixture.updateDir, UPDATE_FILES.request);
      if (existsSync(request)) {
        const text = readFileSync(request, "utf8");
        seen.push(text);
        rmSync(request);
        writeFileSync(join(fixture.updateDir, UPDATE_FILES.result), `id=${/^id=(.*)$/m.exec(text)![1]}\ncode=${code}\n`);
      }
      await sleep(ms);
    };
    return seen;
  };

  it("leaves the image for the updater, touches no container itself, and reports the new image once the updater is done", async () => {
    const fixture = server();
    await fixture.install();
    const seen = updater(fixture, 0);
    const result = await fixture.adopted.update("u1", NEXT);
    expect(seen).toEqual([`id=u1\nimage=${NEXT}\n`]);
    expect(result).toMatchObject({ previousImage: RUNNING, snapshot: null, home: { state: "running" } });
    expect(fixture.docker.calls.filter((call) => !call.startsWith("exec "))).toEqual([]);
    expect(fixture.state.home()).toMatchObject({ image: NEXT, previousImage: RUNNING, operation: null });
    expect(fixture.steps).toEqual(["u1 request", "u1 wait"]);
  });

  it("maps each way the updater ends to a code, and refuses when the server has no updater or the image is not MausBot's", async () => {
    for (const [code, expected] of [[1, "update_rolled_back"], [2, "rollback_failed"], [3, "busy"], [4, "update_not_started"], [127, "update_unavailable"], [9, "docker"]] as const) {
      const fixture = server();
      await fixture.install();
      updater(fixture, code);
      await expect(fixture.adopted.update("u1", NEXT), String(code)).rejects.toMatchObject({ code: expected });
      expect(fixture.state.home().operation).toBeNull();
    }
    const bare = server();
    await bare.install();
    await expect(bare.adopted.update("u2", NEXT)).rejects.toMatchObject({ code: "update_unavailable" });
    await expect(bare.adopted.update("u3", CLOUD_HOME)).rejects.toMatchObject({ code: "image_refused" });
    expect(existsSync(join(bare.updateDir, UPDATE_FILES.request))).toBe(false);
  });

  it("says so when the updater never answers, and takes its late verdict after a restart", async () => {
    const fixture = server();
    await fixture.install();
    writeFileSync(join(fixture.updateDir, UPDATE_FILES.runner), "1\n");
    await expect(fixture.adopted.update("u1", NEXT)).rejects.toMatchObject({ code: "interrupted" });
    fixture.state.saveHome({ ...fixture.state.home(), operation: { jobId: "u7", type: "update", phase: "wait", previousImage: RUNNING, nextImage: NEXT, target: null, dataAtRisk: false, wasRunning: true, startedAt: 1 } });
    writeFileSync(join(fixture.updateDir, UPDATE_FILES.result), "id=u7\ncode=0\n");
    expect(await fixture.adopted.recover()).toMatchObject({ id: "u7", ok: true, result: { previousImage: RUNNING } });
  });
});

describe("a customer-run server: MausBot's requests", () => {
  async function connected(options: { paused?: () => boolean } = {}) {
    const admin = new FakeAdmin();
    await admin.listen();
    cleanups.push(() => admin.close());
    const record: AgentRecord = await enroll({ admin: admin.origin, code: admin.mintCode(), host, connector: identity, mode: "customer-run" });
    admin.boxes.get(record.boxId)!.state = "accepted";
    const audits: AuditEvent[] = [];
    const refusals: Refusal[] = [];
    const handled: Job[] = [];
    let count = 0;
    const agent = new Agent({
      identity: () => record, log: () => {}, heartbeatMs: 100, random: () => 0, nextCount: () => ++count, mode: "customer-run", outgoing: reducedReply,
      heartbeat: async () => reducedHeartbeat({ host: health, home: { state: "running", image: RUNNING, health: null }, connector: identity, paused: false, seats: 7 }),
      handle: async (job) => {
        handled.push(job);
        return { id: job.id, ok: false, error: { code: "docker", message: `Docker said: ${EMAIL}` } };
      },
      stream: (stream, accept) => serveCustomerRunRequest(stream, accept, {
        paused: options.paused ?? (() => false), record: (event) => audits.push(event),
        facts: async () => ({ home: { state: "running", image: RUNNING, health: { ok: true, version: "0.1.151", image: RUNNING, box: null, at: 1 } }, connector: identity, seats: 7, previousImage: null }),
      }),
      refused: (refusal) => refusals.push(refusal),
    });
    cleanups.push(() => agent.stop());
    agent.start();
    await until(() => agent.connected);
    return { admin, record, audits, refusals, handled };
  }
  const bodyOf = (answer: { body: string }) => JSON.parse(answer.body) as unknown;

  it("tells MausBot its mode when it enrols and in every heartbeat, and an operated server's enrolment is unchanged", async () => {
    const { admin, record } = await connected();
    expect(admin.boxes.get(record.boxId)!.enroll.mode).toBe("customer-run");
    expect(record.mode).toBe("customer-run");
    await until(() => admin.heartbeats.length >= 1);
    expect(admin.heartbeats[0]).toMatchObject({ mode: "customer-run", paused: false, seats: 7 });
    const operated = await enroll({ admin: admin.origin, code: admin.mintCode(), host, connector: identity });
    expect(Object.keys(admin.boxes.get(operated.boxId)!.enroll).sort()).toEqual(["code", "connector", "host", "publicKey"]);
    expect("mode" in operated).toBe(false);
  });

  it("answers the four requests on its list itself, with numbers and versions only", async () => {
    const { admin, audits } = await connected();
    expect(Object.keys(CUSTOMER_RUN_REQUESTS)).toEqual(["GET /v1/health", "GET /v1/version", "GET /v1/seats", "GET /v1/update"]);
    expect(bodyOf(await admin.fetch("/v1/health"))).toEqual({ state: "running", ok: true });
    expect(bodyOf(await admin.fetch("/v1/version"))).toEqual({ home: "0.1.151", connector: "1.0.0" });
    expect(bodyOf(await admin.fetch("/v1/seats"))).toEqual({ seats: 7 });
    expect(bodyOf(await admin.fetch("/v1/update"))).toEqual({ state: "running", image: RUNNING, previousImage: null });
    expect(audits).toEqual(["/v1/health", "/v1/version", "/v1/seats", "/v1/update"].map((path) => ({ event: "request", by: "admin", method: "GET", path, status: 200 })));
  });

  it("refuses a pairing, the team summary, the home's own routes and anything with a body, and logs each refusal", async () => {
    const { admin, audits } = await connected();
    const pairing = JSON.stringify({ label: "MausBot dashboard", member: { email: EMAIL, role: "admin" } });
    const refused: [string, string, string?][] = [
      ["POST", "/api/cloud/pairing", pairing], ["GET", "/api/cloud/team/admin"], ["GET", "/api/cloud/health"], ["GET", "/api/health"], ["GET", "/api/seats"],
      ["GET", "/api/bots"], ["GET", "/v1/seats?who=1"], ["POST", "/v1/seats", "{}"], ["GET", "/v1/seats", "{}"], ["DELETE", "/v1/health"], ["GET", "/"],
    ];
    for (const [method, path, body] of refused) {
      const answer = await admin.fetch(path, { method, ...(body ? { body, headers: { "content-type": "application/json" } } : {}) });
      expect(answer.status, `${method} ${path}`).toBe(403);
      expect(bodyOf(answer)).toEqual({ error: "refused_by_mode" });
    }
    expect(audits).toHaveLength(refused.length);
    expect(audits.every((event) => event.event === "request" && event.status === 403 && event.refused === "mode")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(EMAIL);
  });

  it("refuses even the listed requests while remote management is paused", async () => {
    const { admin, audits } = await connected({ paused: () => true });
    const answer = await admin.fetch("/v1/seats");
    expect(answer.status).toBe(403);
    expect(bodyOf(answer)).toEqual({ error: "paused" });
    expect(audits).toEqual([{ event: "request", by: "admin", method: "GET", path: "/v1/seats", status: 403, refused: "paused" }]);
  });

  it("refuses a signed export-disk before it reaches the desk, logs the refusal, and sends back only codes and fixed sentences", async () => {
    const { admin, record, refusals, handled } = await connected();
    admin.send({ job: admin.signJob(record.boxId, { id: "x1", type: "export-disk", args: {} }) });
    expect(await admin.replyTo("x1", 5_000)).toEqual({
      id: "x1", ok: false, error: { code: "refused_by_mode", message: "This server is run by its owner, and this is not a job MausBot may run on it. The server's admin can read the reason with: mausbot-connector audit" },
    });
    admin.send({ job: admin.signJob(record.boxId, { id: "x2", type: "import-disk", args: { url: "https://storage.example.test/d.tar.gz" } }) });
    expect(await admin.replyTo("x2", 5_000)).toMatchObject({ ok: false, error: { code: "refused_by_mode" } });
    expect(handled).toEqual([]);
    expect(refusals.map((refusal) => `${refusal.code} ${refusal.id} ${refusal.type}`)).toEqual(["refused_by_mode x1 export-disk", "refused_by_mode x2 import-disk"]);
    admin.send({ job: admin.signJob(record.boxId, { id: "x3", type: "stop", args: {} }) });
    const failed = await admin.replyTo("x3", 5_000);
    expect(failed).toMatchObject({ ok: false, error: { code: "docker" } });
    expect(JSON.stringify(failed)).not.toContain("@");
    expect(handled.map((job) => job.type)).toEqual(["stop"]);
  });

  it("leaves a server MausBot runs as it was: export-disk reaches the desk, and replies and heartbeats pass as made", async () => {
    const admin = new FakeAdmin();
    await admin.listen();
    cleanups.push(() => admin.close());
    const record = await enroll({ admin: admin.origin, code: admin.mintCode(), host, connector: identity });
    admin.boxes.get(record.boxId)!.state = "accepted";
    const handled: Job[] = [];
    const refusals: Refusal[] = [];
    let count = 0;
    const beat = { heartbeat: { host: health, home: { state: "running" as const, image: CLOUD_HOME, health: null }, connector: identity } };
    const agent = new Agent({
      identity: () => record, log: () => {}, heartbeatMs: 100, random: () => 0, nextCount: () => ++count, heartbeat: async () => beat,
      handle: async (job) => {
        handled.push(job);
        return { id: job.id, ok: false, error: { code: "transfer_failed", message: `The data could not be sent to MausBot (${WRITTEN}).` } };
      },
      refused: (refusal) => refusals.push(refusal),
    });
    cleanups.push(() => agent.stop());
    agent.start();
    await until(() => agent.connected);
    admin.send({ job: admin.signJob(record.boxId, { id: "x1", type: "export-disk", args: {} }) });
    expect(await admin.replyTo("x1", 5_000)).toEqual({ id: "x1", ok: false, error: { code: "transfer_failed", message: `The data could not be sent to MausBot (${WRITTEN}).` } });
    expect(handled.map((job) => job.type)).toEqual(["export-disk"]);
    expect(refusals).toEqual([]);
    await until(() => admin.heartbeats.length >= 1);
    expect(admin.heartbeats[0]).toEqual(beat.heartbeat);
    expect(Object.keys(admin.heartbeats[0]!).sort()).toEqual(["connector", "home", "host"]);
  });
});
