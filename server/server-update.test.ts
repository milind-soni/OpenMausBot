import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { flushAdminActivity, readAdminActivityRange } from "./admin-activity.ts";
import type { RequestAuth } from "./request-auth.ts";
import { requiredScope } from "./request-auth.ts";
import { mayUpdateServer } from "./routes/update-check.ts";
import {
  createServerUpdater, parseRun, parseRunner, readHostFacts, REQUEST_GAP_MS, runOf, serverUpdateStatus, START_WAIT_MS,
  type HostFacts, type PendingUpdate,
} from "./server-update.ts";
import type { UpdateCheck } from "./update-check.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const available: UpdateCheck = { current: "0.1.150", install: "docker", latest: "0.1.151", available: true, command: "git pull && ./update.sh" };
const runner: HostFacts = { runner: { layout: "installer", dir: "/opt/openmausbot", held: false, release: true }, writable: true, last: { run: 3, state: "done", result: "updated", at: NOW - 86_400_000 } };

/** The two folders the installer's compose.yaml gives the server, as the runner leaves them, and a data folder. */
function host(options: { runnerFile?: string | null; last?: string; writable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omb-server-update-"));
  dirs.push(root);
  const dir = join(root, "omb-update");
  const data = join(root, "data");
  mkdirSync(join(dir, "request"), { recursive: true });
  mkdirSync(join(dir, "status"), { recursive: true });
  mkdirSync(data);
  if (options.runnerFile !== null) writeFileSync(join(dir, "status", "runner"), options.runnerFile ?? "layout=installer\ndir=/opt/openmausbot\nheld=no\n");
  writeFileSync(join(dir, "status", "last"), options.last ?? "run=3\nstate=done\nresult=updated\nat=1700000000\nran=1700000000\n");
  if (options.writable === false) chmodSync(join(dir, "request"), 0o500);
  const request = join(dir, "request", "request");
  return { root, dir, data, request, finish: (text: string) => writeFileSync(join(dir, "status", "last"), text) };
}

function updater(box: ReturnType<typeof host>, options: { version?: string; check?: UpdateCheck; now?: () => number; turns?: number } = {}) {
  return createServerUpdater({
    dir: box.dir, dataDir: box.data, install: "docker", version: options.version ?? "0.1.150",
    check: async () => options.check ?? available, activeTurns: () => options.turns ?? 0, now: options.now ?? (() => NOW),
  });
}

const admin = { kind: "session", sessionId: "s1", label: "Laptop", email: "owner@example.test" } as const;

describe("what the host's runner wrote", () => {
  it("reads only the fields it knows, in the shapes it expects", () => {
    expect(parseRunner("layout=installer\ndir=/opt/openmausbot\nheld=no\nrelease=yes\n")).toEqual({ layout: "installer", dir: "/opt/openmausbot", held: false, release: true });
    expect(parseRunner("layout=compose\ndir=/srv/OpenMausBot/deploy\nheld=yes\nrelease=no\n")).toEqual({ layout: "compose", dir: "/srv/OpenMausBot/deploy", held: true, release: false });
    for (const bad of [null, "", "layout=podman\ndir=/opt/x", "layout=installer\ndir=relative", "layout=installer\ndir=/opt/x; rm -rf /"]) expect(parseRunner(bad), String(bad)).toBeNull();
    expect(parseRun("run=4\nstate=running\nat=1700000000\nran=1700000000\n")).toEqual({ run: 4, state: "running", at: 1_700_000_000_000 });
    expect(parseRun("run=4\nstate=done\nresult=rolled-back\nat=1700000000\n")).toEqual({ run: 4, state: "done", result: "rolled-back", at: 1_700_000_000_000 });
    expect(parseRun("run=5\nstate=done\nresult=not-retried\nat=1\nversion=0.1.151\n")).toEqual({ run: 5, state: "done", result: "not-retried", at: 1000, version: "0.1.151" });
    expect(parseRun("run=5\nstate=done\nresult=stale\nat=1\nversion=x;y\n")).toEqual({ run: 5, state: "done", result: "stale", at: 1000 });
    for (const bad of ["run=x\nstate=done\nresult=updated\nat=1", "run=1\nstate=done\nresult=whatever\nat=1", "run=1\nstate=done\nat=1", "run=1\nstate=odd\nat=1"]) expect(parseRun(bad), bad).toBeNull();
  });

  it("knows the runner is there only when its file is, and the request folder takes a file", () => {
    const box = host();
    expect(readHostFacts(box.dir)).toMatchObject({ runner: { layout: "installer" }, writable: true, last: { run: 3 } });
    expect(readHostFacts(undefined)).toEqual({ runner: null, writable: false, last: null });
    expect(readHostFacts(host({ runnerFile: null }).dir).runner).toBeNull();
    if (process.getuid?.() !== 0) expect(readHostFacts(host({ writable: false }).dir).writable).toBe(false);
  });
});

describe("the button's state", () => {
  const status = (patch: Partial<Parameters<typeof serverUpdateStatus>[0]>) =>
    serverUpdateStatus({ install: "docker", check: available, facts: runner, pending: null, version: "0.1.150", activeTurns: 2, now: NOW, ...patch });

  it("offers the button only on a Docker install whose host has the runner, and says the commands it stands for", () => {
    expect(status({})).toEqual({
      mode: "button", current: "0.1.150", latest: "0.1.151", available: true, activeTurns: 2,
      command: "cd /opt/openmausbot && sudo ./update.sh", rollback: "cd /opt/openmausbot && sudo ./update.sh --rollback",
      logs: "cd /opt/openmausbot && sudo docker compose logs --tail 50 omb", setup: "cd /opt/openmausbot && sudo ./update-runner.sh --install",
    });
    expect(status({ facts: { ...runner, runner: { ...runner.runner!, held: true } } }).mode).toBe("held");
  });

  it("never offers the button for a build of main: it says so, with the command that moves it to stable", () => {
    expect(status({ facts: { ...runner, runner: { ...runner.runner!, release: false } } })).toMatchObject({
      mode: "command", why: "unreleased", command: "cd /opt/openmausbot && sudo ./update.sh --allow-older",
    });
  });

  it("shows the command, not the button, when the check follows every release, which update.sh does not take", () => {
    const newest: UpdateCheck = { ...available, channel: "newest", latest: "0.1.152", command: "git pull && ./update.sh --version 0.1.152" };
    expect(status({ check: newest, followsStable: false })).toMatchObject({ mode: "command", command: "git pull && ./update.sh --version 0.1.152" });
    // Before a first version is made stable, the check and update.sh both take the newest release: the button stays.
    expect(status({ check: { ...available, channel: "newest" }, followsStable: true }).mode).toBe("button");
  });

  it("shows the command to run instead wherever the button could not work", () => {
    expect(status({ facts: { runner: null, writable: false, last: null } })).toMatchObject({ mode: "command", command: "git pull && ./update.sh" });
    expect(status({ facts: { ...runner, writable: false } }).mode).toBe("command");
    const npm: UpdateCheck = { ...available, install: "npm", command: "npm install -g openmausbot@0.1.151", restart: true };
    expect(status({ install: "npm", check: npm })).toMatchObject({ mode: "command", command: "npm install -g openmausbot@0.1.151" });
    // A runner's files somewhere else than a container are never the button: npm and Podman get their commands.
    expect(status({ install: "podman", check: { ...available, install: "podman", command: undefined } })).toMatchObject({ mode: "command" });
  });

  it("never shows anything for this computer's app or a Cloud we run", () => {
    expect(status({ install: "managed" })).toEqual({ mode: "none", current: "0.1.150", latest: "0.1.151", available: true, activeTurns: 2 });
    expect(status({ install: "desktop" }).mode).toBe("none");
  });

  it("follows one request from asked to its outcome, by the runner's run number", () => {
    const pending: PendingUpdate = { at: NOW, baseline: 3, from: "0.1.150" };
    expect(runOf(pending, runner.last, "0.1.150", NOW + 1000)).toEqual({ outcome: "requested", from: "0.1.150", at: NOW });
    expect(runOf(pending, { run: 4, state: "running", at: NOW + 2000 }, "0.1.150", NOW + 3000)?.outcome).toBe("running");
    expect(runOf(pending, { run: 4, state: "done", result: "updated", at: NOW + 60_000 }, "0.1.151", NOW + 61_000)).toEqual({ outcome: "updated", from: "0.1.150", to: "0.1.151", at: NOW });
    expect(runOf(pending, { run: 4, state: "done", result: "updated", at: NOW + 60_000 }, "0.1.150", NOW + 61_000)?.outcome).toBe("unchanged");
    expect(runOf(pending, { run: 4, state: "done", result: "rolled-back", at: NOW + 60_000 }, "0.1.150", NOW + 61_000)).toMatchObject({ outcome: "rolled-back", to: "0.1.150" });
    expect(runOf(pending, { run: 4, state: "done", result: "rollback-failed", at: NOW + 60_000 }, "0.1.150", NOW + 61_000)?.outcome).toBe("rollback-failed");
    expect(runOf(pending, { run: 4, state: "done", result: "too-soon", at: NOW + 60_000 }, "0.1.150", NOW + 61_000)).toMatchObject({ outcome: "not-changed", reason: "too-soon" });
    expect(runOf(pending, { run: 4, state: "done", result: "not-retried", at: NOW + 60_000, version: "0.1.151" }, "0.1.150", NOW + 61_000)).toMatchObject({ outcome: "not-changed", reason: "not-retried", target: "0.1.151" });
    expect(runOf(pending, runner.last, "0.1.150", NOW + START_WAIT_MS + 1)?.outcome).toBe("not-started");
    // A run cut off (a reboot) is not "updating" for ever; an old outcome is not shown for ever.
    expect(runOf(pending, { run: 4, state: "running", at: NOW }, "0.1.150", NOW + 3 * 60 * 60_000)).toMatchObject({ outcome: "not-changed", reason: "failed" });
    expect(runOf(pending, { run: 4, state: "done", result: "updated", at: NOW }, "0.1.151", NOW + 2 * 60 * 60_000)).toBeUndefined();
    expect(runOf(null, runner.last, "0.1.150", NOW)).toBeUndefined();
  });
});

describe("a request", () => {
  it("leaves a file the host only needs to see, records it for after the restart, and logs who asked", async () => {
    const box = host();
    const done = await updater(box).request(admin);
    expect(done.status).toBe(202);
    expect((done.body.status as { run: unknown }).run).toEqual({ outcome: "requested", from: "0.1.150", at: NOW });
    expect(readFileSync(box.request, "utf8")).toMatch(/^[0-9a-f-]{36}\n$/);
    expect(JSON.parse(readFileSync(join(box.data, "server-update.json"), "utf8"))).toEqual({ at: NOW, baseline: 3, from: "0.1.150" });
    await flushAdminActivity(box.data);
    const rows = readAdminActivityRange(box.data, { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) });
    expect(rows).toEqual([expect.objectContaining({ category: "config", action: "update.server", target: { kind: "server", name: "0.1.150 → 0.1.151" }, actor: admin })]);
  });

  it("is one at a time: a second press while one runs is answered with the running one", async () => {
    const box = host();
    const one = updater(box);
    const presses = await Promise.all([one.request(admin), one.request(admin)]);
    expect(presses.map((press) => press.status).sort()).toEqual([202, 409]);
    const again = await updater(box, { now: () => NOW + 1000 }).request(admin);
    expect(again).toMatchObject({ status: 409, body: { code: "running", status: { run: { outcome: "requested" } } } });
    box.finish("run=4\nstate=running\nat=1800000001\nran=1800000001\n");
    expect(await updater(box, { now: () => NOW + 2000 }).request(admin)).toMatchObject({ status: 409, body: { code: "running" } });
  });

  it("is refused for five minutes after the last one, and when there is nothing to update to", async () => {
    const box = host();
    expect((await updater(box).request(admin)).status).toBe(202);
    box.finish("run=4\nstate=done\nresult=refused\nat=1800000030\nran=1800000000\n");
    rmSync(box.request, { force: true });
    const soon = await updater(box, { now: () => NOW + 60_000 }).request(admin);
    expect(soon).toMatchObject({ status: 429, body: { code: "too-soon", status: { retryAt: NOW + REQUEST_GAP_MS } } });
    expect(existsSync(box.request)).toBe(false);
    expect((await updater(box, { now: () => NOW + REQUEST_GAP_MS + 1 }).request(admin)).status).toBe(202);
    const current = host();
    expect(await updater(current, { check: { ...available, available: false, latest: "0.1.150" } }).request(admin)).toMatchObject({ status: 409, body: { code: "up-to-date" } });
    expect(existsSync(current.request)).toBe(false);
  });

  it("is refused, with nothing written, where the button cannot work", async () => {
    const none = host({ runnerFile: null });
    expect(await updater(none).request(admin)).toMatchObject({ status: 409, body: { code: "unavailable", status: { mode: "command" } } });
    const held = host({ runnerFile: "layout=installer\ndir=/opt/openmausbot\nheld=yes\n" });
    expect(await updater(held).request(admin)).toMatchObject({ status: 409, body: { code: "unavailable", status: { mode: "held" } } });
    for (const box of [none, held]) {
      expect(existsSync(box.request)).toBe(false);
      expect(readdirSync(box.data)).toEqual([]);
    }
    const managed = createServerUpdater({ dir: undefined, dataDir: host().data, install: "managed", version: "0.1.150", check: async () => available, activeTurns: () => 0 });
    expect(await managed.request(admin)).toMatchObject({ status: 409, body: { status: { mode: "none" } } });
  });

  it("withdraws a request the host never took, so a runner switched on later does not act on it", async () => {
    const box = host();
    await updater(box).request(admin);
    expect(existsSync(box.request)).toBe(true);
    const status = await updater(box, { now: () => NOW + START_WAIT_MS + 1 }).status();
    expect(status.run?.outcome).toBe("not-started");
    expect(existsSync(box.request)).toBe(false);
  });

  it("reads the outcome after the restart, from what the runner wrote", async () => {
    const box = host();
    await updater(box).request(admin);
    box.finish("run=4\nstate=done\nresult=updated\nat=1800000120\nran=1800000001\n");
    expect((await updater(box, { version: "0.1.151", now: () => NOW + 130_000 }).status()).run).toEqual({ outcome: "updated", from: "0.1.150", to: "0.1.151", at: NOW });
    box.finish("run=4\nstate=done\nresult=rolled-back\nat=1800000120\nran=1800000001\n");
    expect((await updater(box, { now: () => NOW + 130_000 }).status()).run).toMatchObject({ outcome: "rolled-back", to: "0.1.150" });
  });
});

describe("who may press it", () => {
  const session = (scopes: string[]) => ({ kind: "session", session: {}, via: "cookie", scopes }) as unknown as RequestAuth;

  it("an admin's session; never a member, a bot's shell or anything else on loopback", () => {
    expect(mayUpdateServer(session(["admin", "client"]))).toBe(true);
    expect(mayUpdateServer(session(["client"]))).toBe(false);
    expect(mayUpdateServer({ kind: "loopback", scopes: ["admin", "client"] })).toBe(false);
    expect(mayUpdateServer({ kind: "loopback", scopes: ["client"], trust: "service" })).toBe(false);
  });

  it("is an admin route for the central check: a member's session never reaches it", () => {
    expect(requiredScope("GET", "/api/updates/server")).toBe("admin");
    expect(requiredScope("POST", "/api/updates/server")).toBe("admin");
  });
});
