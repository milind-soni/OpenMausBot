// The home on this server: one container from our image on one data volume, run with exactly the settings the bot box
// needs, kept running, updated with a safety copy and rolled back when the new version does not come up.
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import { DockerError, type ContainerSpec, type Docker, type Mount } from "./docker.ts";
import { JobFailure } from "./failure.ts";
import { publicHost, summarizeHealth, type HealthRead } from "./home-health.ts";
import { errorText, registerSecret, type Log } from "./log.ts";
import { EXPORT_PATH, UPDATE_HEALTH_WINDOW_MS, type CopyInfo, type HomeHealth, type HomeReport, type HomeState, type JobError, type JobReply, type JobResults } from "./protocol.ts";
import {
  APPARMOR_PROFILE, BACKUPS_KEPT, HOME_CAPABILITIES, HOME_OOM_SCORE_ADJ, HOME_PORT, HOME_SHM_BYTES, HOME_STOP_TIMEOUT_S, LABELS, LEASE_FIXED_VERSION, NAMES,
} from "./settings.ts";
import type { HomeRecord, Operation, StateStore } from "./state.ts";
import type { Transfer } from "./transfer.ts";

const DATA: Mount = { Type: "volume", Source: NAMES.dataVolume, Target: "/data" };
/** What a copy of /data needs as root: read every file, and write it back with its owner, mode and times. */
const COPY_CAPS = ["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID"];
const READ_CAPS = ["DAC_READ_SEARCH"];
const DELETE_CAPS = ["DAC_OVERRIDE", "DAC_READ_SEARCH"];

/** A digest of the home's environment, kept as a label: a start with another environment makes a new container. */
export function envDigest(env: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).digest("hex");
}

/** The home container, with exactly the settings its bot box needs on a stock Docker host, and nothing more. */
export function homeSpec(image: string, env: Record<string, string>, seccomp: string): ContainerSpec {
  const environment = { ...env, OMB_CLOUD_IMAGE: image };
  return {
    Image: image,
    Env: Object.entries(environment).map(([name, value]) => `${name}=${value}`),
    Labels: { [LABELS.role]: "home", [LABELS.image]: image, [LABELS.env]: envDigest(environment) },
    ExposedPorts: { [`${HOME_PORT}/tcp`]: {} },
    StopTimeout: HOME_STOP_TIMEOUT_S,
    HostConfig: {
      Init: true,
      ShmSize: HOME_SHM_BYTES,
      PortBindings: { [`${HOME_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(HOME_PORT) }] },
      Mounts: [DATA],
      SecurityOpt: [`apparmor=${APPARMOR_PROFILE}`, `seccomp=${seccomp}`, "no-new-privileges=true"],
      // Docker's `--security-opt systempaths=unconfined`: no masked or read-only /proc paths (the AppArmor profile denies them).
      MaskedPaths: [],
      ReadonlyPaths: [],
      CapDrop: ["ALL"],
      CapAdd: [...HOME_CAPABILITIES],
      OomScoreAdj: HOME_OOM_SCORE_ADJ,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "20m", "max-file": "5" } },
    },
  };
}

/** A short-lived container from the home's own image that runs one fixed command on the volumes, without a network. */
export function helperSpec(image: string, mounts: Mount[], command: string[], caps: string[]): ContainerSpec {
  return {
    Image: image,
    Entrypoint: [command[0]],
    Cmd: command.slice(1),
    User: "0:0",
    WorkingDir: "/",
    Labels: { [LABELS.role]: "helper" },
    HostConfig: {
      Mounts: mounts,
      NetworkMode: "none",
      CapDrop: ["ALL"],
      CapAdd: caps,
      SecurityOpt: ["no-new-privileges=true"],
      LogConfig: { Type: "json-file", Config: { "max-size": "1m" } },
    },
  };
}

/** "v0.1.130" → [0, 1, 130]. */
export function imageVersion(label: string | undefined): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(label ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionBelow(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

const lastLine = (text: string) => text.trim().split("\n").pop()?.slice(0, 300) ?? "";
const spoken = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${Math.round(ms / 1000)} seconds`);
const gb = (bytes: number) => Math.round((bytes / 1e9) * 10) / 10;

export interface HomeOptions {
  docker: Docker;
  state: StateStore;
  log: Log;
  readHealth: HealthRead;
  /** The seccomp profile install.sh put in /etc/mausbot, as JSON text. */
  seccomp: () => string;
  /** Free bytes where Docker keeps its volumes. */
  diskFree: () => number;
  transfer: Transfer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  updateWindowMs?: number;
  startWindowMs?: number;
  pollMs?: number;
}

type Waited = { ok: true } | { ok: false; reason: string };

export class Home {
  private readonly docker: Docker;
  private readonly state: StateStore;
  private readonly log: Log;
  private readonly options: HomeOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly updateWindowMs: number;
  private readonly startWindowMs: number;
  private readonly pollMs: number;
  private lastHealth: HomeHealth | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private active = 0;
  private crashes = 0;
  private nextRestartAt = 0;

  constructor(options: HomeOptions) {
    this.options = options;
    this.docker = options.docker;
    this.state = options.state;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.updateWindowMs = options.updateWindowMs ?? UPDATE_HEALTH_WINDOW_MS;
    this.startWindowMs = options.startWindowMs ?? UPDATE_HEALTH_WINDOW_MS;
    this.pollMs = options.pollMs ?? 2_000;
    const env = this.state.homeEnv();
    if (env) registerHomeSecrets(env);
  }

  /** True while a job or a restart holds the home. */
  get busy(): boolean {
    return this.active > 0;
  }

  /** Runs `work` alone: jobs that change the home or its data never overlap. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.active += 1;
      try { return await work(); } finally { this.active -= 1; }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async report(): Promise<HomeReport> {
    const record = this.state.home();
    const info = await this.docker.containerInspect(NAMES.home);
    let state: HomeState;
    if (record.operation?.type === "update") state = "updating";
    else if (record.operation?.type === "restore" || record.operation?.type === "import-disk") state = "restoring";
    else if (!info) state = "absent";
    else if (info.State.Running) state = this.lastHealth?.ok && this.lastHealth.image === info.Config.Image ? "running" : "starting";
    else state = record.desired === "running" ? "crashed" : "stopped";
    return { state, image: info?.Config.Image ?? record.image, health: this.lastHealth };
  }

  /** Reads the running home's signed health report; the next report() carries it. */
  async refreshHealth(): Promise<HomeHealth | null> {
    const env = this.state.homeEnv();
    const info = await this.docker.containerInspect(NAMES.home);
    if (!env || !info?.State.Running) return this.lastHealth;
    const { status, report } = await this.options.readHealth({ port: HOME_PORT, publicHost: publicHost(env), secret: env.OMB_CLOUD_BOOTSTRAP_SECRET });
    this.lastHealth = summarizeHealth(status, report, info.Config.Image, this.now());
    return this.lastHealth;
  }

  async copies(): Promise<{ backups: CopyInfo[]; snapshot: CopyInfo | null }> {
    const backups = (await this.docker.listVolumes({ [LABELS.role]: "backup" }))
      .filter((volume) => volume.Name.startsWith(NAMES.backupPrefix))
      .map((volume) => copyInfo(volume.Name.slice(NAMES.backupPrefix.length), "backup", volume.Labels))
      .sort((a, b) => b.createdAt - a.createdAt);
    const snapshot = await this.docker.volumeInspect(NAMES.snapshotVolume);
    return { backups, snapshot: snapshot ? copyInfo("snapshot", "snapshot", snapshot.Labels) : null };
  }

  start(jobId: string, image: string, env: Record<string, string>): Promise<JobResults["start"]> {
    return this.exclusive(async () => {
      registerHomeSecrets(env);
      this.state.saveHomeEnv(env);
      const record = this.state.home();
      this.state.saveHome({ ...record, desired: "running", image, operation: { jobId, type: "start", phase: "start", previousImage: record.image, nextImage: image, target: null, dataAtRisk: false, wasRunning: false, startedAt: this.now() } });
      try {
        await this.ensureImage(image);
        await this.ensureDataVolume();
        await this.ensureContainer(image, env);
        await this.startHome(image);
        const waited = await this.waitHealthy(image, this.startWindowMs);
        if (!waited.ok) throw new JobFailure("unhealthy", waited.reason);
      } finally {
        const after = this.state.home();
        this.state.saveHome({ ...after, previousImage: record.image && record.image !== image ? record.image : after.previousImage, operation: null });
      }
      return { home: await this.report() };
    });
  }

  stop(): Promise<JobResults["stop"]> {
    return this.exclusive(async () => {
      this.state.saveHome({ ...this.state.home(), desired: "stopped" });
      await this.docker.stopContainer(NAMES.home, HOME_STOP_TIMEOUT_S);
      this.lastHealth = null;
      return { home: await this.report() };
    });
  }

  restart(): Promise<JobResults["restart"]> {
    return this.exclusive(async () => {
      const { image, env } = this.current();
      this.state.saveHome({ ...this.state.home(), desired: "running" });
      await this.docker.stopContainer(NAMES.home, HOME_STOP_TIMEOUT_S);
      await this.ensureContainer(image, env);
      await this.startHome(image);
      const waited = await this.waitHealthy(image, this.startWindowMs);
      if (!waited.ok) throw new JobFailure("unhealthy", waited.reason);
      return { home: await this.report() };
    });
  }

  /** Pull → safety copy of /data → swap → wait for the new image's health → else put back the old image and the copy. */
  update(jobId: string, image: string): Promise<JobResults["update"]> {
    return this.exclusive(async () => {
      const { image: previous, env } = this.current();
      const record = this.state.home();
      const wasRunning = (await this.docker.containerInspect(NAMES.home))?.State.Running === true;
      this.begin({ jobId, type: "update", phase: "pull", previousImage: previous, nextImage: image, target: null, dataAtRisk: false, wasRunning });
      try {
        await this.ensureImage(image);
        await this.ensureRoomForCopy(previous);
      } catch (error) {
        this.finish({});
        throw error;
      }
      this.phase({ phase: "stop" });
      const snapshot = await this.stopAndCopy(previous, wasRunning);
      this.phase({ phase: "swap", dataAtRisk: true });
      this.state.saveHome({ ...this.state.home(), desired: "running" });
      let failure: string | null = null;
      try {
        await this.createContainer(image, env);
        await this.startHome(image);
        this.phase({ phase: "wait" });
        const waited = await this.waitHealthy(image, this.updateWindowMs);
        if (!waited.ok) failure = waited.reason;
      } catch (error) {
        failure = errorText(error);
      }
      if (failure !== null) {
        this.log(`update to ${image} failed (${failure}); rolling back to ${previous}`);
        await this.rollBack(previous, env, `The new version did not become healthy (${failure})`);
      }
      this.finish({ image, previousImage: previous, desired: "running" });
      const older = record.previousImage;
      if (older && older !== image && older !== previous) await this.docker.removeImage(older).catch(() => {});
      this.log(`updated the home from ${previous} to ${image}`);
      return { home: await this.report(), previousImage: previous, snapshot };
    });
  }

  backup(jobId: string): Promise<JobResults["backup"]> {
    return this.exclusive(async () => {
      const { image } = this.current();
      await this.ensureRoomForCopy(image);
      const wasRunning = (await this.docker.containerInspect(NAMES.home))?.State.Running === true;
      const id = backupId(this.now());
      this.begin({ jobId, type: "backup", phase: "stop", previousImage: image, nextImage: null, target: `${NAMES.backupPrefix}${id}`, dataAtRisk: false, wasRunning });
      try {
        await this.docker.stopContainer(NAMES.home, HOME_STOP_TIMEOUT_S);
        this.phase({ phase: "copy" });
        await this.copyVolume(image, NAMES.dataVolume, `${NAMES.backupPrefix}${id}`, "backup");
      } finally {
        if (wasRunning) await this.restartAfter(image);
        this.finish({});
      }
      const { backups } = await this.copies();
      for (const old of backups.slice(BACKUPS_KEPT)) await this.docker.removeVolume(`${NAMES.backupPrefix}${old.id}`);
      return { backup: backups.find((copy) => copy.id === id) ?? { id, kind: "backup", createdAt: this.now(), image } };
    });
  }

  restore(jobId: string, id: string): Promise<JobResults["restore"]> {
    return this.exclusive(async () => {
      const { image, env } = this.current();
      const source = `${NAMES.backupPrefix}${id}`;
      const volume = await this.docker.volumeInspect(source);
      if (!volume || volume.Labels?.[LABELS.role] !== "backup") throw new JobFailure("not_found", `There is no backup ${id} on this server.`);
      await this.ensureRoomForCopy(image);
      const wasRunning = (await this.docker.containerInspect(NAMES.home))?.State.Running === true;
      this.begin({ jobId, type: "restore", phase: "stop", previousImage: image, nextImage: null, target: source, dataAtRisk: false, wasRunning });
      await this.stopAndCopy(image, wasRunning);
      this.phase({ phase: "copy", dataAtRisk: true });
      try {
        await this.overwriteVolume(image, source, NAMES.dataVolume);
      } catch (error) {
        await this.putBackSnapshot(image);
        this.finish({});
        if (wasRunning) await this.restartAfter(image);
        throw new JobFailure("docker", `Restoring backup ${id} failed (${errorText(error)}); the data is as it was.`);
      }
      this.phase({ phase: "start", dataAtRisk: false });
      this.state.saveHome({ ...this.state.home(), desired: "running" });
      await this.ensureContainer(image, env);
      await this.startHome(image);
      const waited = await this.waitHealthy(image, this.startWindowMs);
      this.finish({});
      if (!waited.ok) throw new JobFailure("unhealthy", `Backup ${id} is back, but the home did not become healthy (${waited.reason}).`);
      return { home: await this.report(), backupId: id };
    });
  }

  /** A gzip tar of /data, copied while the home is stopped, then uploaded to the Admin once the home runs again. */
  exportDisk(jobId: string, admin: { origin: string; token: string }): Promise<JobResults["export-disk"]> {
    return this.exclusive(async () => {
      const { image } = this.current();
      await this.ensureRoomForCopy(image);
      const wasRunning = (await this.docker.containerInspect(NAMES.home))?.State.Running === true;
      const archive = `export-${jobId}.tar.gz`;
      this.begin({ jobId, type: "export-disk", phase: "stop", previousImage: image, nextImage: null, target: archive, dataAtRisk: false, wasRunning });
      try {
        await this.docker.stopContainer(NAMES.home, HOME_STOP_TIMEOUT_S);
        this.phase({ phase: "archive" });
        const made = await this.helper(image, [{ ...DATA, ReadOnly: true }, this.stateMount()], ["tar", "-C", "/data", "-czf", `/state/${archive}`, "."], READ_CAPS);
        if (made.code !== 0) throw new JobFailure("docker", `Archiving the data failed (${lastLine(made.output)}).`);
      } catch (error) {
        rmSync(this.state.path(archive), { force: true });
        if (wasRunning) await this.restartAfter(image);
        this.finish({});
        throw error;
      }
      if (wasRunning) await this.restartAfter(image);
      this.phase({ phase: "upload" });
      try {
        const sent = await this.options.transfer.upload(`${admin.origin}${EXPORT_PATH}/${jobId}`, { authorization: `Bearer ${admin.token}` }, this.state.path(archive));
        return { bytes: sent.bytes, sha256: sent.sha256 };
      } catch (error) {
        throw new JobFailure("transfer_failed", `The data could not be sent to MausBot (${errorText(error)}).`);
      } finally {
        rmSync(this.state.path(archive), { force: true });
        this.finish({});
      }
    });
  }

  /** Replaces /data with the gzip tar at `url`, keeping a safety copy until the home runs on it. */
  importDisk(jobId: string, url: string, admin: { origin: string; token: string }): Promise<JobResults["import-disk"]> {
    return this.exclusive(async () => {
      const { image, env } = this.current();
      const archive = `import-${jobId}.tar.gz`;
      const wasRunning = (await this.docker.containerInspect(NAMES.home))?.State.Running === true;
      this.begin({ jobId, type: "import-disk", phase: "download", previousImage: image, nextImage: null, target: archive, dataAtRisk: false, wasRunning });
      let bytes: number;
      try {
        // The token goes only to the Admin itself, never to a storage address it hands out.
        const headers: Record<string, string> = new URL(url).origin === admin.origin ? { authorization: `Bearer ${admin.token}` } : {};
        bytes = (await this.options.transfer.download(url, headers, this.state.path(archive), Math.max(0, this.options.diskFree() - 2e9))).bytes;
        await this.ensureRoomForCopy(image);
      } catch (error) {
        rmSync(this.state.path(archive), { force: true });
        this.finish({});
        throw error instanceof JobFailure ? error : new JobFailure("transfer_failed", `The data could not be downloaded (${errorText(error)}).`);
      }
      this.phase({ phase: "stop" });
      try {
        await this.stopAndCopy(image, wasRunning);
      } finally {
        if (this.state.home().operation === null) rmSync(this.state.path(archive), { force: true });
      }
      this.phase({ phase: "extract", dataAtRisk: true });
      try {
        await this.wipeVolume(image, NAMES.dataVolume);
        const unpacked = await this.helper(image, [DATA, { ...this.stateMount(), ReadOnly: true }], ["tar", "-C", "/data", "-xzpf", `/state/${archive}`], COPY_CAPS);
        if (unpacked.code !== 0) throw new Error(lastLine(unpacked.output) || `tar exited ${unpacked.code}`);
      } catch (error) {
        await this.putBackSnapshot(image);
        this.finish({});
        if (wasRunning) await this.restartAfter(image);
        throw new JobFailure("transfer_failed", `The archive could not be unpacked (${errorText(error)}); the data is as it was.`);
      } finally {
        rmSync(this.state.path(archive), { force: true });
      }
      this.phase({ phase: "start", dataAtRisk: false });
      this.finish({});
      if (wasRunning || this.state.home().desired === "running") {
        await this.ensureContainer(image, env);
        await this.startHome(image);
        const waited = await this.waitHealthy(image, this.startWindowMs);
        if (!waited.ok) throw new JobFailure("unhealthy", `The data is in place, but the home did not become healthy on it (${waited.reason}).`);
      }
      return { home: await this.report(), bytes };
    });
  }

  /** Starts the home again when it stopped on its own; waits longer after each crash in a row. */
  async supervise(): Promise<void> {
    if (this.busy) return;
    const record = this.state.home();
    const env = this.state.homeEnv();
    if (record.desired !== "running" || !record.image || !env || record.operation) return;
    const info = await this.docker.containerInspect(NAMES.home);
    if (info?.State.Running) {
      if (this.now() - Date.parse(info.State.StartedAt) > 10 * 60_000) this.crashes = 0;
      return;
    }
    if (this.now() < this.nextRestartAt) return;
    this.crashes += 1;
    this.nextRestartAt = this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(this.crashes - 1, 6));
    const image = record.image;
    this.log(info ? `the home stopped on its own (exit ${info.State.ExitCode}); starting it again` : "the home's container is gone; making it again");
    await this.exclusive(async () => {
      await this.ensureContainer(image, env);
      await this.startHome(image);
    }).catch((error) => this.log(`could not start the home again: ${errorText(error)}`));
  }

  /** At start: a job the connector was in the middle of is finished safely, and its result is for the Admin. */
  recover(): Promise<JobReply | null> {
    return this.exclusive(async () => {
      const record = this.state.home();
      const op = record.operation;
      if (!op) return null;
      this.log(`the connector restarted during ${op.type} (${op.phase}); finishing it safely`);
      const env = this.state.homeEnv();
      const previous = op.previousImage ?? record.image;
      let image = previous;
      let outcome = "nothing was changed";
      if (op.type === "update" && op.phase === "wait" && op.nextImage && env) {
        const waited = await this.waitHealthy(op.nextImage, 60_000);
        if (waited.ok) {
          this.finish({ image: op.nextImage, previousImage: previous, desired: "running" });
          return { id: op.jobId, ok: true, result: { home: await this.report(), previousImage: previous, snapshot: (await this.copies()).snapshot } } as JobReply;
        }
      }
      if (op.dataAtRisk && previous) {
        await this.docker.removeContainer(NAMES.home);
        await this.putBackSnapshot(previous);
        outcome = "the data was put back as it was before";
      }
      if (op.type === "backup" && op.target) await this.docker.removeVolume(op.target);
      if ((op.type === "export-disk" || op.type === "import-disk") && op.target) rmSync(this.state.path(op.target), { force: true });
      if (op.type === "start") image = op.nextImage;
      this.finish({ image, ...(op.type === "update" ? { desired: "running" as const } : {}) });
      if (image && env && (op.wasRunning || this.state.home().desired === "running")) {
        await this.ensureContainer(image, env);
        await this.startHome(image).catch((error) => this.log(`could not start the home: ${errorText(error)}`));
        outcome += op.type === "update" ? `, and the home runs ${image} again` : ", and the home was started again";
      }
      const error: JobError = { code: "interrupted", message: `The connector restarted during this ${op.type}; ${outcome}.`, ...(op.type === "update" && image ? { image } : {}) };
      return { id: op.jobId, ok: false, error };
    });
  }

  private current(): { image: string; env: Record<string, string> } {
    const record = this.state.home();
    const env = this.state.homeEnv();
    if (!record.image || !env) throw new JobFailure("no_home", "This server has no home yet: start one first.");
    return { image: record.image, env };
  }

  private begin(op: Omit<Operation, "startedAt">): void {
    this.state.saveHome({ ...this.state.home(), operation: { ...op, startedAt: this.now() } });
  }

  private phase(patch: Partial<Operation>): void {
    const record = this.state.home();
    if (record.operation) this.state.saveHome({ ...record, operation: { ...record.operation, ...patch } });
  }

  private finish(patch: Partial<HomeRecord>): void {
    this.state.saveHome({ ...this.state.home(), ...patch, operation: null });
  }

  private async ensureImage(image: string): Promise<void> {
    if (await this.docker.imageInspect(image)) return;
    this.log(`downloading ${image}`);
    try {
      await this.docker.pull(image);
    } catch (error) {
      throw new JobFailure("pull_failed", `Could not download ${image} (${errorText(error)}). Nothing was changed.`);
    }
  }

  private async ensureDataVolume(): Promise<void> {
    if (!(await this.docker.volumeInspect(NAMES.dataVolume))) await this.docker.createVolume(NAMES.dataVolume, { [LABELS.role]: "data" });
  }

  /** Keeps a container made from the same image and environment; anything else is made again. */
  private async ensureContainer(image: string, env: Record<string, string>): Promise<void> {
    const info = await this.docker.containerInspect(NAMES.home);
    const wanted = envDigest({ ...env, OMB_CLOUD_IMAGE: image });
    if (info && info.Config.Image === image && info.Config.Labels?.[LABELS.env] === wanted) return;
    await this.createContainer(image, env);
  }

  private async createContainer(image: string, env: Record<string, string>): Promise<void> {
    await this.docker.removeContainer(NAMES.home);
    await this.docker.createContainer(NAMES.home, homeSpec(image, env, this.options.seccomp()));
  }

  private async startHome(image: string): Promise<void> {
    await this.clearStaleLease(image);
    try {
      await this.docker.startContainer(NAMES.home);
    } catch (error) {
      const message = errorText(error);
      if (/port is already allocated|address already in use/i.test(message)) {
        throw new JobFailure("port_in_use", `Port ${HOME_PORT} on this server's loopback is used by another program, and MausBot's home needs it.`);
      }
      if (error instanceof DockerError && /apparmor|seccomp/i.test(message)) {
        throw new JobFailure("box_unavailable", "The bot box's security profiles are not installed on this server. Run the install command again to repair it.");
      }
      throw new JobFailure("docker", `Docker could not start the home (${message}).`);
    }
    this.lastHealth = null;
  }

  /**
   * Until a home image clears it itself (LEASE_FIXED_VERSION), a home killed uncleanly leaves its data-directory lease
   * on the volume and the next one refuses to start: containers share the host's boot id and reuse pids. Only ever
   * while no container at all runs on the volume, so a live server's lease is never touched.
   */
  private async clearStaleLease(image: string): Promise<void> {
    const version = imageVersion((await this.docker.imageInspect(image))?.Config?.Labels?.["org.opencontainers.image.version"]);
    if (version && !versionBelow(version, LEASE_FIXED_VERSION)) return;
    if ((await this.docker.containersUsing(NAMES.dataVolume)).some((container) => container.State === "running" || container.State === "paused")) return;
    const cleared = await this.helper(image, [DATA], [
      "find", "/data", "-maxdepth", "3", "(",
      "-path", "/data/.openmausbot/openmausbot-server.lease*", "-o", "-path", "/data/.openmausbot/.openmausbot-server-child/openmausbot-server.lease",
      ")", "-print", "-delete",
    ], DELETE_CAPS);
    const paths = cleared.output.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/data/"));
    if (paths.length) this.log(`cleared the data-directory lease records a stopped home left: ${paths.join(", ")}`);
  }

  private async waitHealthy(image: string, windowMs: number): Promise<Waited> {
    const deadline = this.now() + windowMs;
    const env = this.state.homeEnv();
    if (!env) return { ok: false, reason: "the home has no environment" };
    for (;;) {
      const info = await this.docker.containerInspect(NAMES.home);
      if (!info || !info.State.Running) {
        const why = info ? await this.startupFailure(info.State.ExitCode) : "its container is gone";
        return { ok: false, reason: `the home stopped: ${why}` };
      }
      const { status, report } = await this.options.readHealth({ port: HOME_PORT, publicHost: publicHost(env), secret: env.OMB_CLOUD_BOOTSTRAP_SECRET });
      this.lastHealth = summarizeHealth(status, report, image, this.now());
      if (this.lastHealth.ok) return { ok: true };
      if (this.now() >= deadline) return { ok: false, reason: `it did not report ${image} within ${spoken(windowMs)}` };
      await this.sleep(this.pollMs);
    }
  }

  /** The home's own last word when it exits at boot ("Cloud home startup failed: …"); its launcher never logs a secret. */
  private async startupFailure(exitCode: number): Promise<string> {
    const lines = (await this.docker.logs(NAMES.home, 40).catch(() => "")).split("\n");
    const said = lines.reverse().find((line) => line.includes("startup failed:"));
    return said ? said.slice(said.indexOf("startup failed:") + 16).trim().slice(0, 300) : `exit ${exitCode}`;
  }

  private stateMount(): Mount {
    return { Type: "volume", Source: NAMES.stateVolume, Target: "/state" };
  }

  private async helper(image: string, mounts: Mount[], command: string[], caps: string[]): Promise<{ code: number; output: string }> {
    const name = `mausbot-helper-${randomBytes(4).toString("hex")}`;
    await this.docker.createContainer(name, helperSpec(image, mounts, command, caps));
    try {
      await this.docker.startContainer(name);
      const code = await this.docker.waitContainer(name, 6 * 60 * 60_000);
      return { code, output: await this.docker.logs(name, 50) };
    } finally {
      await this.docker.removeContainer(name).catch(() => {});
    }
  }

  private async ensureRoomForCopy(image: string): Promise<void> {
    const measured = await this.helper(image, [{ ...DATA, ReadOnly: true }], ["du", "-sk", "/data"], READ_CAPS);
    const used = Number(/^(\d+)/.exec(measured.output.trim())?.[1] ?? NaN) * 1024;
    if (!Number.isFinite(used)) return;
    const free = this.options.diskFree();
    const needed = used * 1.1 + 1e9;
    if (free < needed) {
      throw new JobFailure("disk_full", `There is not enough free disk for a safety copy of the data: it needs about ${gb(needed)} GB and ${gb(free)} GB are free. Free some space or add a disk.`);
    }
  }

  private async snapshot(image: string): Promise<CopyInfo> {
    await this.copyVolume(image, NAMES.dataVolume, NAMES.snapshotVolume, "snapshot");
    return { id: "snapshot", kind: "snapshot", createdAt: this.now(), image };
  }

  /** Stops the home and copies /data aside; when the copy fails, the home runs again as it was and the job ends. */
  private async stopAndCopy(image: string, wasRunning: boolean): Promise<CopyInfo> {
    await this.docker.stopContainer(NAMES.home, HOME_STOP_TIMEOUT_S);
    this.phase({ phase: "snapshot" });
    try {
      return await this.snapshot(image);
    } catch (error) {
      this.finish({});
      if (wasRunning) await this.restartAfter(image);
      throw error;
    }
  }

  private async copyVolume(image: string, from: string, to: string, kind: "backup" | "snapshot"): Promise<void> {
    await this.docker.removeVolume(to);
    await this.docker.createVolume(to, { [LABELS.role]: kind, [LABELS.created]: String(this.now()), [LABELS.image]: image });
    const copied = await this.helper(image, [{ Type: "volume", Source: from, Target: "/from", ReadOnly: true }, { Type: "volume", Source: to, Target: "/to" }],
      ["cp", "-a", "/from/.", "/to/"], COPY_CAPS);
    if (copied.code !== 0) {
      await this.docker.removeVolume(to);
      throw new JobFailure("docker", `Copying the data failed (${lastLine(copied.output)}); nothing was changed.`);
    }
  }

  private async wipeVolume(image: string, volume: string): Promise<void> {
    const wiped = await this.helper(image, [{ Type: "volume", Source: volume, Target: "/to" }], ["find", "/to", "-mindepth", "1", "-delete"], DELETE_CAPS);
    if (wiped.code !== 0) throw new Error(`clearing the data failed (${lastLine(wiped.output)})`);
  }

  private async overwriteVolume(image: string, from: string, to: string): Promise<void> {
    await this.wipeVolume(image, to);
    const copied = await this.helper(image, [{ Type: "volume", Source: from, Target: "/from", ReadOnly: true }, { Type: "volume", Source: to, Target: "/to" }],
      ["cp", "-a", "/from/.", "/to/"], COPY_CAPS);
    if (copied.code !== 0) throw new Error(`copying the data back failed (${lastLine(copied.output)})`);
  }

  private async putBackSnapshot(image: string): Promise<void> {
    if (!(await this.docker.volumeInspect(NAMES.snapshotVolume))) throw new JobFailure("rollback_failed", "The safety copy of the data is missing; the data was left as it is.");
    await this.overwriteVolume(image, NAMES.snapshotVolume, NAMES.dataVolume);
  }

  private async rollBack(previous: string, env: Record<string, string>, why: string): Promise<never> {
    this.phase({ phase: "rollback" });
    if ((await this.docker.containerInspect(NAMES.home))?.State.Paused) await this.docker.unpauseContainer(NAMES.home);
    await this.docker.removeContainer(NAMES.home);
    await this.putBackSnapshot(previous);
    this.phase({ dataAtRisk: false });
    let back = false;
    try {
      await this.createContainer(previous, env);
      await this.startHome(previous);
      back = (await this.waitHealthy(previous, this.startWindowMs)).ok;
    } catch (error) {
      this.log(`the previous version did not start again: ${errorText(error)}`);
    }
    this.finish({ image: previous, desired: "running" });
    if (!back) throw new JobFailure("rollback_failed", `${why}. The previous version and its data are back, but it did not become healthy either.`, previous);
    throw new JobFailure("update_rolled_back", `${why}. The previous version and its data are back.`, previous);
  }

  private async restartAfter(image: string): Promise<void> {
    const env = this.state.homeEnv();
    if (!env) return;
    try {
      await this.ensureContainer(image, env);
      await this.startHome(image);
    } catch (error) {
      this.log(`could not start the home again: ${errorText(error)}`);
    }
  }
}

function copyInfo(id: string, kind: CopyInfo["kind"], labels: Record<string, string> | null): CopyInfo {
  const created = Number(labels?.[LABELS.created]);
  return { id, kind, createdAt: Number.isFinite(created) ? created : 0, image: labels?.[LABELS.image] ?? null };
}

/** "20261028-104512-3fa9": sortable, and a valid `restore` id. */
export function backupId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Every value of a secret-shaped name in the home's environment never reaches a log. */
export function registerHomeSecrets(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) if (/(?:SECRET|TOKEN|GRANT|KEY|PASSWORD)$/.test(name)) registerSecret(value);
}

/** The free bytes on the filesystem of `path`; 0 when it cannot be read. */
export function freeBytes(statfs: () => { bavail: number | bigint; bsize: number | bigint }): number {
  try {
    const stats = statfs();
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

