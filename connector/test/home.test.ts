import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JobFailure } from "../src/failure.ts";
import type { HealthRead } from "../src/home-health.ts";
import { Home, homeSpec, imageVersion } from "../src/home.ts";
import { registerSecret } from "../src/log.ts";
import { StateStore, type Operation } from "../src/state.ts";
import type { Transfer } from "../src/transfer.ts";
import { FakeDocker } from "./fake-docker.ts";

const image = (letter: string) => `ghcr.io/milind-soni/openmausbot-cloud-home@sha256:${letter.repeat(64)}`;
const A = image("a"), B = image("b"), C = image("c");
const SECRET = "Bootstrap-secret-0123456789abcdefghijklmnopq";
const RELAY = "box_omb_relay-token-0123456789abcdefghijklmnop";
const env = {
  OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
  OMB_PUBLIC_URL: "https://acme.example.test", OMB_CLOUD_BOOTSTRAP_SECRET: SECRET, OMB_CLOUD_BOAT_TOKEN: RELAY,
};
const SECCOMP = '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}';
const LEASE = ".openmausbot/openmausbot-server.lease";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { free?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-connector-home-"));
  dirs.push(dir);
  const state = new StateStore(join(dir, "state"));
  const docker = new FakeDocker(state.dir);
  let clock = 1_800_000_000_000;
  docker.now = () => clock;
  for (const [ref, version] of [[A, "v0.1.130"], [B, "v0.1.131"], [C, "v0.1.132"]] as const) docker.publish(ref, version);
  const healthy = new Set<string>([A, B, C]);
  const lines: string[] = [];
  const readHealth: HealthRead = async (target) => {
    const home = docker.container("mausbot-home");
    if (!home || home.status !== "running") return { status: 0, report: null };
    const homeEnv = Object.fromEntries((home.spec.Env ?? []).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
    if (target.secret !== homeEnv.OMB_CLOUD_BOOTSTRAP_SECRET) return { status: 401, report: { error: "invalid_signature" } };
    if (target.publicHost !== new URL(homeEnv.OMB_PUBLIC_URL).hostname || target.port !== 8080) return { status: 403, report: null };
    if (!healthy.has(home.spec.Image)) return { status: 0, report: null };
    return { status: 200, report: { version: "0.1.130", image: homeEnv.OMB_CLOUD_IMAGE, box: { box: "bwrap", checks: "32/32", failed: [] } } };
  };
  const uploads: { url: string; headers: Record<string, string>; body: string }[] = [];
  const downloads: { url: string; headers: Record<string, string> }[] = [];
  let archive = JSON.stringify([["imported.txt", "from the old home"]]);
  const transfer: Transfer = {
    async download(url, headers, file) {
      downloads.push({ url, headers });
      writeFileSync(file, archive);
      return { bytes: archive.length };
    },
    async upload(url, headers, file) {
      const body = readFileSync(file, "utf8");
      uploads.push({ url, headers, body });
      return { bytes: body.length, sha256: "0".repeat(64) };
    },
  };
  const home = new Home({
    docker, state, log: (line) => lines.push(line), readHealth, seccomp: () => SECCOMP, transfer,
    diskFree: () => options.free ?? 500e9,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    updateWindowMs: 600_000, startWindowMs: 600_000, pollMs: 2_000,
  });
  const data = () => docker.files("mausbot-data");
  const write = (path: string, content: string) => docker.volume("mausbot-data").files.set(path, content);
  return {
    dir, state, docker, home, healthy, lines, uploads, downloads, data, write,
    clock: () => clock,
    advance: (ms: number) => { clock += ms; },
    setArchive: (value: string) => { archive = value; },
  };
}

async function started(f: ReturnType<typeof fixture>, ref = A) {
  const result = await f.home.start("start-1", ref, env);
  expect(result.home).toMatchObject({ state: "running", image: ref, health: { ok: true, image: ref } });
  return result;
}

async function failure(promise: Promise<unknown>): Promise<JobFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JobFailure) return error;
    throw error;
  }
  throw new Error("the job did not fail");
}

describe("the home on an own server", () => {
  it("starts the home with exactly the settings the bot box needs, and keeps its environment readable by root only", async () => {
    const f = fixture();
    const result = await started(f);
    expect(result.home.health?.box).toEqual({ box: "bwrap", checks: "32/32", failed: [] });
    const spec = f.docker.container("mausbot-home")!.spec;
    expect(spec).toEqual(homeSpec(A, env, SECCOMP));
    expect(spec.HostConfig).toMatchObject({
      Init: true, ShmSize: 512 * 1024 * 1024, MaskedPaths: [], ReadonlyPaths: [], CapDrop: ["ALL"], CapAdd: ["CHOWN", "SETUID", "SETGID", "KILL"], OomScoreAdj: -800,
      SecurityOpt: ["apparmor=omb-home-narrow", `seccomp=${SECCOMP}`, "no-new-privileges=true"], RestartPolicy: { Name: "no" },
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] }, Mounts: [{ Type: "volume", Source: "mausbot-data", Target: "/data" }],
    });
    expect(spec.StopTimeout).toBe(30);
    expect(Object.keys(spec.HostConfig)).not.toContain("Privileged");
    expect(spec.Env).toEqual([...Object.entries(env).map(([name, value]) => `${name}=${value}`), `OMB_CLOUD_IMAGE=${A}`]);
    expect(JSON.parse(readFileSync(f.state.path("home-env.json"), "utf8"))).toEqual(env);
    if (process.platform !== "win32") {
      expect(statSync(f.state.path("home-env.json")).mode & 0o777).toBe(0o600);
      expect(statSync(f.state.dir).mode & 0o777).toBe(0o700);
    }
    expect(f.state.home()).toMatchObject({ desired: "running", image: A, operation: null });
    for (const line of f.lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(RELAY);
    }
  });

  it("clears the lease a killed home left before each start, until the image clears it itself, and never while a home runs", async () => {
    const f = fixture();
    await f.docker.createVolume("mausbot-data", {});
    for (const path of [LEASE, `${LEASE}.reap-0f5e6c4a-1b2c-4d3e-8f9a-0b1c2d3e4f5a`, ".openmausbot/.openmausbot-server-child/openmausbot-server.lease"]) f.write(path, "{}");
    f.write(".openmausbot/state.json", "keep");
    f.write("notes/openmausbot-server.lease", "someone's file");
    await started(f);
    expect(f.data()).toEqual({ ".openmausbot/state.json": "keep", "notes/openmausbot-server.lease": "someone's file" });
    expect(f.lines.some((line) => line.startsWith("cleared the data-directory lease records a stopped home left: /data/.openmausbot/openmausbot-server.lease"))).toBe(true);
    // A start while the home runs never touches its live lease.
    f.write(LEASE, "{}");
    const finds = () => f.docker.helperRuns.filter((command) => command[0] === "find" && command[1] === "/data").length;
    const before = finds();
    await started(f);
    expect(finds()).toBe(before);
    expect(f.data()[LEASE]).toBe("{}");
    // Nor while any other container runs on the volume.
    await f.home.stop();
    await f.docker.createContainer("someones-own", { Image: A, HostConfig: { Mounts: [{ Type: "volume", Source: "mausbot-data", Target: "/data" }] } });
    await f.docker.startContainer("someones-own");
    await f.home.restart();
    expect(finds()).toBe(before);
    expect(f.data()[LEASE]).toBe("{}");
    await f.docker.removeContainer("someones-own");
    // An image from the release that fixed the lease clears it itself.
    await f.home.stop();
    await started(f, B);
    expect(finds()).toBe(before);
    expect(f.data()[LEASE]).toBe("{}");
    expect(imageVersion("v0.1.131")).toEqual([0, 1, 131]);
    expect(imageVersion("latest")).toBeNull();
  });

  it("updates by a safety copy and a swap, keeps the previous image for a rollback, and removes the one before it", async () => {
    const f = fixture();
    await started(f);
    f.write("a.txt", "1");
    f.docker.calls.splice(0);
    const result = await f.home.update("update-1", B);
    expect(result).toMatchObject({ home: { state: "running", image: B, health: { ok: true, image: B } }, previousImage: A, snapshot: { id: "snapshot", kind: "snapshot", image: A } });
    expect(f.docker.files("mausbot-snapshot")).toEqual({ "a.txt": "1" });
    expect(f.data()).toEqual({ "a.txt": "1" });
    const order = f.docker.calls.filter((call) => /^(pull|stop|rm|create|start) (mausbot-home|ghcr)/.test(call));
    expect(order).toEqual([`pull ${B}`, "stop mausbot-home", "rm mausbot-home", `create mausbot-home ${B}`, "start mausbot-home"]);
    expect(f.state.home()).toMatchObject({ desired: "running", image: B, previousImage: A, operation: null });
    expect(f.docker.images.has(A)).toBe(true);
    await f.home.update("update-2", C);
    expect(f.docker.calls).toContain(`rmi ${A}`);
    expect(f.docker.images.has(A)).toBe(false);
    expect(f.docker.images.has(B)).toBe(true);
  });

  it("rolls back to the previous image and the data as it was when the new version does not come up within ten minutes", async () => {
    const f = fixture();
    await started(f);
    f.write("a.txt", "1");
    f.healthy.delete(B);
    f.docker.onHomeStart = (container) => {
      if (container.spec.Image === B) f.write("written-by-the-new-version.txt", "x");
    };
    const began = f.clock();
    const failed = await failure(f.home.update("update-1", B));
    expect(failed.toJobError()).toEqual({
      code: "update_rolled_back", image: A,
      message: `The new version did not become healthy (it did not report ${B} within 10 minutes). The previous version and its data are back.`,
    });
    expect(f.clock() - began).toBeGreaterThanOrEqual(600_000);
    expect(f.docker.container("mausbot-home")).toMatchObject({ status: "running", spec: { Image: A } });
    expect(f.data()).toEqual({ "a.txt": "1" });
    expect(f.state.home()).toMatchObject({ desired: "running", image: A, operation: null });
    expect((await f.home.report())).toMatchObject({ state: "running", image: A, health: { ok: true, image: A } });
  });

  it("rolls back at once when the new version exits as it boots, saying what it said", async () => {
    const f = fixture();
    await started(f);
    f.docker.onHomeStart = (container) => {
      if (container.spec.Image !== B) return;
      container.status = "exited";
      container.exitCode = 1;
      container.logs = "cloud home: something\nCloud home startup failed: This volume belongs to another Cloud machine. No data was changed.\n";
    };
    const began = f.clock();
    const failed = await failure(f.home.update("update-1", B));
    expect(failed.code).toBe("update_rolled_back");
    expect(failed.message).toContain("the home stopped: This volume belongs to another Cloud machine. No data was changed.");
    expect(f.clock() - began).toBeLessThan(60_000);
    expect(f.docker.container("mausbot-home")?.spec.Image).toBe(A);
  });

  it("puts the data back even when the new version is frozen, and says so when the old one does not come back either", async () => {
    const f = fixture();
    await started(f);
    f.write("a.txt", "1");
    f.docker.onHomeStart = (container) => {
      if (container.spec.Image !== B) return;
      f.write("b.txt", "2");
      container.status = "paused";
    };
    f.healthy.delete(B);
    expect((await failure(f.home.update("update-1", B))).code).toBe("update_rolled_back");
    expect(f.data()).toEqual({ "a.txt": "1" });
    f.healthy.delete(A);
    f.healthy.delete(C);
    f.docker.onHomeStart = null;
    const failed = await failure(f.home.update("update-2", C));
    expect(failed.toJobError()).toMatchObject({ code: "rollback_failed", image: A });
    expect(failed.message).toContain("The previous version and its data are back, but it did not become healthy either.");
  });

  it("starts the home again as it was when the safety copy itself fails, before anything was swapped", async () => {
    const f = fixture();
    await started(f);
    f.write("a.txt", "1");
    const { backup } = await f.home.backup("backup-1");
    f.docker.failCopy = true;
    const admin = { origin: "https://cloud.example.test", token: "t".repeat(40) };
    for (const job of [() => f.home.update("update-1", B), () => f.home.restore("restore-1", backup.id), () => f.home.importDisk("import-1", "https://storage.example.test/d.tgz", admin)]) {
      expect(await failure(job())).toMatchObject({ code: "docker", message: "Copying the data failed (cp: error writing '/to/big.bin': No space left on device); nothing was changed." });
      expect(f.docker.container("mausbot-home")).toMatchObject({ status: "running", spec: { Image: A } });
      expect(f.state.home()).toMatchObject({ image: A, desired: "running", operation: null });
      expect(f.data()).toEqual({ "a.txt": "1" });
    }
    expect(readdirSync(f.state.dir).filter((name) => name.startsWith("import-"))).toEqual([]);
  });

  it("changes nothing when the new image cannot be downloaded or there is no room for a safety copy", async () => {
    const f = fixture();
    await started(f);
    f.docker.calls.splice(0);
    const missing = image("d");
    expect((await failure(f.home.update("update-1", missing))).toJobError()).toMatchObject({ code: "pull_failed" });
    expect(f.docker.calls.filter((call) => call.startsWith("stop") || call.startsWith("rm"))).toEqual([]);
    expect(f.docker.container("mausbot-home")).toMatchObject({ status: "running", spec: { Image: A } });
    expect(f.state.home().operation).toBeNull();

    const tight = fixture({ free: 0.5e9 });
    await started(tight);
    const full = await failure(tight.home.update("update-2", B));
    expect(full.toJobError()).toMatchObject({ code: "disk_full" });
    expect(full.message).toMatch(/needs about [\d.]+ GB and 0.5 GB are free/);
    expect(tight.docker.container("mausbot-home")).toMatchObject({ status: "running", spec: { Image: A } });
  });

  it("keeps the newest three backups and restores one, taking a safety copy of the data first", async () => {
    const f = fixture();
    await started(f);
    const made: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      f.write("n.txt", String(n));
      const { backup } = await f.home.backup(`backup-${n}`);
      expect(backup).toMatchObject({ kind: "backup", image: A });
      expect(backup.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
      made.push(backup.id);
      f.advance(60_000);
    }
    const { backups } = await f.home.copies();
    expect(backups.map((copy) => copy.id).sort()).toEqual(made.slice(1).sort());
    expect(f.docker.files(`mausbot-backup-${made[1]}`)).toEqual({ "n.txt": "2" });
    expect(f.docker.container("mausbot-home")?.status).toBe("running");
    f.write("n.txt", "now");
    const restored = await f.home.restore("restore-1", made[1]);
    expect(restored).toMatchObject({ backupId: made[1], home: { state: "running" } });
    expect(f.data()).toEqual({ "n.txt": "2" });
    expect(f.docker.files("mausbot-snapshot")).toEqual({ "n.txt": "now" });
    expect((await failure(f.home.restore("restore-2", "20260101-000000-0000"))).code).toBe("not_found");
  });

  it("sends a gzip tar of /data to the Admin with the agent token, with the home running again meanwhile, and leaves no archive behind", async () => {
    const f = fixture();
    await started(f);
    f.write("a.txt", "1");
    const result = await f.home.exportDisk("export-1", { origin: "https://cloud.example.test", token: "agent-token-0123456789abcdefghijklmnopqrst" });
    expect(result).toEqual({ bytes: f.uploads[0].body.length, sha256: "0".repeat(64) });
    expect(f.uploads).toEqual([{ url: "https://cloud.example.test/api/cloud/servers/agent/export/export-1", headers: { authorization: "Bearer agent-token-0123456789abcdefghijklmnopqrst" }, body: JSON.stringify([["a.txt", "1"]]) }]);
    expect(readdirSync(f.state.dir).filter((name) => name.startsWith("export-"))).toEqual([]);
    expect(f.docker.container("mausbot-home")?.status).toBe("running");
  });

  it("replaces /data with an archive, sends the token only to the Admin, and puts the data back when the archive is bad", async () => {
    const f = fixture();
    await started(f);
    f.write("old.txt", "1");
    const admin = { origin: "https://cloud.example.test", token: "agent-token-0123456789abcdefghijklmnopqrst" };
    const imported = await f.home.importDisk("import-1", "https://storage.example.test/disk.tgz?sig=x", admin);
    expect(imported).toMatchObject({ bytes: expect.any(Number), home: { state: "running" } });
    expect(f.data()).toEqual({ "imported.txt": "from the old home" });
    expect(f.docker.files("mausbot-snapshot")).toEqual({ "old.txt": "1" });
    expect(f.downloads[0]).toEqual({ url: "https://storage.example.test/disk.tgz?sig=x", headers: {} });
    await f.home.importDisk("import-2", "https://cloud.example.test/api/cloud/servers/agent/import/import-2", admin);
    expect(f.downloads[1].headers).toEqual({ authorization: `Bearer ${admin.token}` });
    f.setArchive("not an archive");
    const bad = await failure(f.home.importDisk("import-3", "https://storage.example.test/bad.tgz", admin));
    expect(bad.toJobError()).toMatchObject({ code: "transfer_failed" });
    expect(bad.message).toContain("the data is as it was");
    expect(f.data()).toEqual({ "imported.txt": "from the old home" });
    expect(f.docker.container("mausbot-home")?.status).toBe("running");
    expect(readdirSync(f.state.dir).filter((name) => name.startsWith("import-"))).toEqual([]);
  });

  it("starts a home that stopped on its own again, waiting longer each time, and never one the Admin stopped", async () => {
    const f = fixture();
    await started(f);
    const crash = () => Object.assign(f.docker.container("mausbot-home")!, { status: "exited", exitCode: 137 });
    crash();
    f.write(LEASE, "{}");
    await f.home.supervise();
    expect(f.docker.container("mausbot-home")?.status).toBe("running");
    expect(f.data()[LEASE]).toBeUndefined();
    expect(f.lines).toContain("the home stopped on its own (exit 137); starting it again");
    crash();
    await f.home.supervise();
    expect(f.docker.container("mausbot-home")?.status).toBe("exited");
    expect((await f.home.report()).state).toBe("crashed");
    await f.home.stop();
    expect((await f.home.report()).state).toBe("stopped");
    await f.home.supervise();
    expect(f.docker.container("mausbot-home")?.status).toBe("exited");
  });

  it("finishes an update the connector was in the middle of: kept when the new home is healthy, else rolled back", async () => {
    const kept = fixture();
    await started(kept);
    await kept.home.update("update-1", B);
    const op = (patch: Partial<Operation>): Operation => ({ jobId: "update-9", type: "update", phase: "wait", previousImage: A, nextImage: B, target: null, dataAtRisk: true, wasRunning: true, startedAt: 1, ...patch });
    kept.state.saveHome({ ...kept.state.home(), image: A, operation: op({}) });
    expect(await kept.home.recover()).toMatchObject({ id: "update-9", ok: true, result: { previousImage: A, home: { image: B } } });
    expect(kept.state.home()).toMatchObject({ image: B, operation: null });

    const back = fixture();
    await started(back);
    back.write("a.txt", "1");
    await back.home.update("update-1", B);
    back.healthy.delete(C);
    back.write("a.txt", "changed by C");
    back.state.saveHome({ ...back.state.home(), operation: op({ previousImage: B, nextImage: C }) });
    await back.docker.pull(C);
    await back.docker.removeContainer("mausbot-home");
    await back.docker.createContainer("mausbot-home", homeSpec(C, env, SECCOMP));
    await back.docker.startContainer("mausbot-home");
    const reply = await back.home.recover();
    expect(reply).toEqual({ id: "update-9", ok: false, error: { code: "interrupted", image: B, message: `The connector restarted during this update; the data was put back as it was before, and the home runs ${B} again.` } });
    expect(back.data()).toEqual({ "a.txt": "1" });
    expect(back.docker.container("mausbot-home")).toMatchObject({ status: "running", spec: { Image: B } });
    expect(await back.home.recover()).toBeNull();
  });

  it("never puts a secret in a job's error, even when Docker's own message carries one", async () => {
    registerSecret(SECRET);
    const f = fixture();
    await started(f);
    await f.home.stop();
    f.docker.startFailures.set("mausbot-home", `container create failed: env OMB_CLOUD_BOOTSTRAP_SECRET=${SECRET} rejected`);
    const failed = await failure(f.home.restart());
    expect(failed.code).toBe("docker");
    expect(JSON.stringify(failed.toJobError())).not.toContain(SECRET);
    f.docker.startFailures.set("mausbot-home", "driver failed programming external connectivity: Bind for 127.0.0.1:8080 failed: port is already allocated");
    expect((await failure(f.home.restart())).toJobError()).toEqual({ code: "port_in_use", message: "Port 8080 on this server's loopback is used by another program, and MausBot's home needs it." });
    f.docker.startFailures.set("mausbot-home", "OCI runtime create failed: apparmor failed to apply profile: write /proc/self/attr/apparmor/exec: no such file or directory");
    expect((await failure(f.home.restart())).code).toBe("box_unavailable");
    expect(existsSync(f.state.path("agent.json"))).toBe(false);
  });

  it("refuses jobs on a home that was never started", async () => {
    const f = fixture();
    for (const job of [() => f.home.update("u", B), () => f.home.restart(), () => f.home.backup("b"), () => f.home.restore("r", "x")]) {
      expect((await failure(job())).code).toBe("no_home");
    }
    expect((await f.home.report()).state).toBe("absent");
  });
});
