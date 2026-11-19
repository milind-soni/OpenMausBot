import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ContainerSpec } from "../src/docker.ts";
import type { Job, JobReply } from "../src/protocol.ts";
import { SelfUpdater, successorSpec } from "../src/self-update.ts";
import { StateStore } from "../src/state.ts";
import { FakeDocker, type FakeContainer } from "./fake-docker.ts";

const OLD = `ghcr.io/milind-soni/indbot-connector@sha256:${"1".repeat(64)}`;
const NEW = `ghcr.io/milind-soni/indbot-connector@sha256:${"2".repeat(64)}`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const envOf = (container: FakeContainer) => Object.fromEntries((container.spec.Env ?? []).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));

/** The connector container as install.sh starts it. */
function installed(instance: string): ContainerSpec {
  return {
    Image: OLD,
    Env: [`INDBOT_INSTANCE=${instance}`, `INDBOT_CONNECTOR_IMAGE=${OLD}`, "INDBOT_UPDATE_WAIT_S=60", "PATH=/usr/local/bin:/usr/bin:/bin"],
    Cmd: ["run"],
    Labels: { "com.indbot.role": "connector", "com.indbot.instance": instance },
    HostConfig: {
      Binds: ["/var/run/docker.sock:/var/run/docker.sock", "indbot-connector:/state", "/etc/indbot:/etc/indbot:ro"],
      NetworkMode: "host", RestartPolicy: { Name: "unless-stopped" }, SecurityOpt: ["no-new-privileges=true"], CapDrop: ["ALL"], ReadonlyRootfs: true, Tmpfs: { "/tmp": "" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-connector-update-"));
  dirs.push(dir);
  const state = new StateStore(join(dir, "state"));
  const docker = new FakeDocker(state.dir);
  docker.publish(OLD, null);
  docker.publish(NEW, null);
  await docker.pull(OLD);
  await docker.createContainer("indbot-connector", installed("instance-old"));
  await docker.startContainer("indbot-connector");
  let clock = 1_800_000_000_000;
  const lines: string[] = [];
  const updater = (instance: string) => new SelfUpdater({
    docker, state, log: (line) => lines.push(line), instance, deadlineMs: 180_000, pollMs: 2_000,
    identity: () => ({ version: "1.0.0", protocol: 2, image: instance === "instance-old" ? OLD : NEW }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const agent = { paused: 0, resumed: 0, pause() { this.paused += 1; }, resume() { this.resumed += 1; } };
  const job: Job<"self-update"> = { id: "self-1", type: "self-update", args: { image: NEW } };
  return { dir, state, docker, updater, agent, job, lines };
}

describe("the connector replacing itself", () => {
  it("never starts a new connector the image check refuses", async () => {
    const f = await fixture();
    const updater = new SelfUpdater({
      docker: f.docker, state: f.state, log: () => {}, instance: "instance-old",
      identity: () => ({ version: "1.0.0", protocol: 2, image: OLD }),
      checkImage: async (image, context) => { if (image === NEW && context.kind === "connector" && context.current === OLD) throw new Error("it is older than this one"); },
    });
    expect(await updater.run(f.job, f.agent)).toEqual({ id: "self-1", ok: false, error: { code: "image_refused", message: `${NEW} was refused (it is older than this one). The connector was not changed.` } });
    expect([...f.docker.containers.keys()]).toEqual(["indbot-connector"]);
    expect(f.agent).toMatchObject({ paused: 0, resumed: 0 });
  });

  it("hands over once the new connector has connected: it answers the job, removes the old one and takes its name", async () => {
    const f = await fixture();
    let candidateReply: JobReply | null = null;
    f.docker.onConnectorStart = async (container) => {
      const started = await f.updater(envOf(container).INDBOT_INSTANCE).atStart(async () => true);
      if (started.role === "candidate") candidateReply = started.reply;
    };
    const reply = await f.updater("instance-old").run(f.job, f.agent);
    expect(reply).toBeNull();
    expect(candidateReply).toEqual({ id: "self-1", ok: true, result: { connector: { version: "1.0.0", protocol: 2, image: NEW } } });
    expect([...f.docker.containers.keys()]).toEqual(["indbot-connector"]);
    const now = f.docker.container("indbot-connector")!;
    expect(now.spec.Image).toBe(NEW);
    const instance = envOf(now).INDBOT_INSTANCE;
    expect(instance).not.toBe("instance-old");
    expect(envOf(now)).toEqual({ INDBOT_UPDATE_WAIT_S: "60", INDBOT_INSTANCE: instance, INDBOT_CONNECTOR_IMAGE: NEW });
    expect(now.spec.Labels).toMatchObject({ "com.indbot.role": "connector", "com.indbot.instance": instance });
    expect(now.spec.HostConfig).toEqual(installed("x").HostConfig);
    expect(now.spec.Cmd).toEqual(["run"]);
    expect(f.agent).toMatchObject({ paused: 1, resumed: 0 });
    expect(readdirSync(f.state.dir).filter((name) => name.startsWith("self-update"))).toEqual(["self-update.confirmed.json"]);
    // Started again later, the new connector finds nothing left to do; the next update clears the record.
    expect((await f.updater(instance).atStart(async () => true)).role).toBe("none");
    expect([...f.docker.containers.keys()]).toEqual(["indbot-connector"]);
  });

  it("keeps the running connector when the new one never connects, and removes the new one", async () => {
    const f = await fixture();
    const reply = await f.updater("instance-old").run(f.job, f.agent);
    expect(reply).toEqual({ id: "self-1", ok: false, error: { code: "self_update_failed", message: "The new connector did not connect to IndBot within 3 minutes; kept this one." } });
    expect([...f.docker.containers.keys()]).toEqual(["indbot-connector"]);
    expect(f.docker.container("indbot-connector")!.spec.Image).toBe(OLD);
    expect(f.agent).toMatchObject({ paused: 1, resumed: 1 });
    expect(readdirSync(f.state.dir).filter((name) => name.startsWith("self-update"))).toEqual([]);
  });

  it("a new connector that cannot connect calls the update off itself, and the old one carries on", async () => {
    const f = await fixture();
    let role = "";
    f.docker.onConnectorStart = async (container) => {
      role = (await f.updater(envOf(container).INDBOT_INSTANCE).atStart(async () => false)).role;
    };
    const reply = await f.updater("instance-old").run(f.job, f.agent);
    expect(role).toBe("superseded");
    expect(reply).toMatchObject({ ok: false, error: { code: "self_update_failed" } });
    expect(f.docker.container("indbot-connector")!.spec.Image).toBe(OLD);
    expect(f.docker.container("indbot-connector-next")).toBeNull();
  });

  it("an old connector started again mid-update waits for the outcome, and stands down only while the new one runs", async () => {
    const f = await fixture();
    const candidate = successorSpec((await f.docker.containerInspect("indbot-connector"))!, NEW, "instance-new");
    await f.docker.pull(NEW);
    await f.docker.createContainer("indbot-connector-next", candidate);
    await f.docker.startContainer("indbot-connector-next");
    const record = { jobId: "self-1", from: OLD, to: NEW, previousContainer: f.docker.container("indbot-connector")!.id, candidateContainer: "indbot-connector-next", candidateInstance: "instance-new", deadline: 1_800_000_060_000 };
    f.state.saveSelfUpdate(record);
    f.state.settleSelfUpdate("confirmed");
    expect((await f.updater("instance-old").atStart(async () => true)).role).toBe("superseded");
    // The record outlived the connector that won: it means nothing on its own.
    await f.docker.removeContainer("indbot-connector-next");
    expect((await f.updater("instance-old").atStart(async () => true)).role).toBe("none");
    expect(existsSync(f.state.path("self-update.confirmed.json"))).toBe(false);
  });

  it("changes nothing when the new image cannot be downloaded, and nothing at all when it already runs it", async () => {
    const f = await fixture();
    const missing = `ghcr.io/milind-soni/indbot-connector@sha256:${"3".repeat(64)}`;
    expect(await f.updater("instance-old").run({ ...f.job, args: { image: missing } }, f.agent)).toMatchObject({ ok: false, error: { code: "self_update_failed" } });
    expect(await f.updater("instance-old").run({ ...f.job, args: { image: OLD } }, f.agent)).toEqual({ id: "self-1", ok: true, result: { connector: { version: "1.0.0", protocol: 2, image: OLD } } });
    expect(f.agent).toMatchObject({ paused: 0, resumed: 0 });
    expect([...f.docker.containers.keys()]).toEqual(["indbot-connector"]);
    expect(await f.updater("instance-unknown").run(f.job, f.agent)).toMatchObject({ ok: false, error: { code: "self_update_failed", message: expect.stringContaining("cannot find its own container") } });
  });
});
