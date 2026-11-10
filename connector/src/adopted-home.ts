// The home on a customer-run server: the MausBot server its owner installed with Docker Compose (deploy/install.sh:
// project `openmausbot`, service `omb`, Caddy in front, the data in a folder beside the Compose file). The connector
// attaches to it and never makes a second one: it starts and stops those containers, copies that folder, and hands an
// update to the server's own updater. It never writes the owner's settings and never picks the home's image itself.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CUSTOMER_HOME_IMAGE, HOME_READS_COMMAND, VERSION_LABEL, olderVersionRefusal, parseHomeReads, type HomeFacts, type JobSource } from "./customer-run.ts";
import type { ContainerInfo, Docker, Mount } from "./docker.ts";
import { JobFailure } from "./failure.ts";
import { backupId, helperSpec } from "./home.ts";
import { errorText, type Log } from "./log.ts";
import type { CopyInfo, HomeHealth, HomeReport, HomeState, JobError, JobReply, JobResults, ServerMode } from "./protocol.ts";
import { BACKUPS_KEPT, HOME_STOP_TIMEOUT_S, LABELS, NAMES } from "./settings.ts";
import type { HomeRecord, Operation, StateStore } from "./state.ts";

export const COMPOSE_PROJECT = "openmausbot";
const SERVICE = "omb";
const FRONT = "caddy";
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";
const HOME_REPOSITORY = "ghcr.io/milind-soni/openmausbot";
const COPY_CAPS = ["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID"];
const READ_CAPS = ["DAC_READ_SEARCH"];
const DELETE_CAPS = ["DAC_OVERRIDE", "DAC_READ_SEARCH"];

/** The request the connector leaves for the server's updater, and the answer it reads: `key=value` lines. */
export const UPDATE_FILES = { runner: "runner", request: "request", result: "result" } as const;
/** deploy/update.sh's exit codes; from the runner itself, 5 for an image older than the one running and 127 when the server has no update.sh. */
const UPDATE_EXIT = { done: 0, rolledBack: 1, rollbackFailed: 2, busy: 3, notStarted: 4, older: 5, missing: 127 } as const;
/** Who asked for a backup, kept on its volume: one sender's backups never push out the other's. */
const MADE_BY_LABEL = "com.mausbot.by";

const lastLine = (text: string) => text.trim().split("\n").pop()?.slice(0, 300) ?? "";
const gb = (bytes: number) => Math.round((bytes / 1e9) * 10) / 10;

export interface Install {
  container: ContainerInfo;
  /** The folder on the server that the home mounts at /data. */
  dataDir: string;
}

/** The Compose install on this server, or the plain sentence that says why the connector cannot attach to one. */
export async function findInstall(docker: Docker): Promise<{ ok: true; install: Install } | { ok: false; why: string }> {
  const [found] = await docker.listContainers({ [PROJECT_LABEL]: COMPOSE_PROJECT, [SERVICE_LABEL]: SERVICE });
  const container = found ? await docker.containerInspect(found.Id) : null;
  if (!container) return { ok: false, why: "MausBot is not installed on this server yet. Install it first with the server's install command, then connect it." };
  const image = container.Config.Image;
  if (!image.startsWith(`${HOME_REPOSITORY}:`) && !image.startsWith(`${HOME_REPOSITORY}@`)) {
    return { ok: false, why: "The MausBot on this server was built here, not downloaded from MausBot's registry, so MausBot cannot update it. Move it to the published image first: ./update.sh --replace-local-build" };
  }
  const data = (container.Mounts ?? []).find((mount) => mount.Destination === "/data");
  if (!data || data.Type !== "bind") return { ok: false, why: "The MausBot on this server does not keep its data in a folder beside its Compose file, so it is not one the server installer made. Install it with the server's install command, then connect it." };
  return { ok: true, install: { container, dataDir: data.Source } };
}

/** True when a MausBot server its owner installed runs here: an `operated` connector must not start a second home beside it. */
export async function standaloneServerPresent(docker: Docker): Promise<boolean> {
  return (await docker.listContainers({ [PROJECT_LABEL]: COMPOSE_PROJECT, [SERVICE_LABEL]: SERVICE })).length > 0;
}

/**
 * Why this server cannot be enrolled in `mode`, in a sentence for the person at the terminal, or null. An `operated`
 * connector makes its own home, so it is refused where a MausBot its owner installed already runs: that would be two.
 */
export async function enrolmentRefusal(mode: ServerMode, docker: Docker): Promise<string | null> {
  if (mode === "customer-run") {
    const found = await findInstall(docker);
    return found.ok ? null : found.why;
  }
  return (await standaloneServerPresent(docker))
    ? "MausBot already runs on this server, installed by its owner. Connecting it this way would start a second MausBot beside it. Run the install command again and it connects the one that is here, keeping its data."
    : null;
}

export interface AdoptedHomeOptions {
  docker: Docker;
  state: StateStore;
  log: Log;
  /** Free bytes where Docker keeps its volumes, so where a backup goes. */
  diskFree: () => number;
  /** The folder shared with the server's updater (mausbot-update-runner.sh), as the connector sees it. */
  updateDir: string;
  onStep?: (step: { id: string; type: Operation["type"]; step: string; detail?: Record<string, unknown> }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  startWindowMs?: number;
  updateDeadlineMs?: number;
  pollMs?: number;
}

export class AdoptedHome {
  private readonly docker: Docker;
  private readonly state: StateStore;
  private readonly log: Log;
  private readonly options: AdoptedHomeOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startWindowMs: number;
  private readonly updateDeadlineMs: number;
  private readonly pollMs: number;
  private lastHealth: HomeHealth | null = null;
  private lastSeats: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private active = 0;

  constructor(options: AdoptedHomeOptions) {
    this.options = options;
    this.docker = options.docker;
    this.state = options.state;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.startWindowMs = options.startWindowMs ?? 10 * 60_000;
    this.updateDeadlineMs = options.updateDeadlineMs ?? 90 * 60_000;
    this.pollMs = options.pollMs ?? 2_000;
  }

  get busy(): boolean {
    return this.active > 0;
  }

  /** How many people can sign in, as the home last said; null when it does not say. */
  get seats(): number | null {
    return this.lastSeats;
  }

  get previousImage(): string | null {
    return this.state.home().previousImage;
  }

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.active += 1;
      try { return await work(); } finally { this.active -= 1; }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Docker restarts the home itself (Compose's `restart: unless-stopped`), so there is nothing to keep running here. */
  async supervise(): Promise<void> {}

  async report(): Promise<HomeReport> {
    const record = this.state.home();
    const container = await this.container(SERVICE);
    let state: HomeState;
    if (record.operation?.type === "update") state = "updating";
    else if (record.operation?.type === "restore") state = "restoring";
    else if (!container) state = "absent";
    else if (container.State.Running) state = this.lastHealth?.ok ? "running" : "starting";
    else state = record.desired === "running" ? "crashed" : "stopped";
    return { state, image: container ? await this.imageOf(container) : record.image, health: this.lastHealth };
  }

  async refreshHealth(): Promise<HomeHealth | null> {
    const container = await this.container(SERVICE);
    if (!container?.State.Running) {
      this.lastHealth = null;
      return null;
    }
    const facts = await this.read(container);
    this.lastSeats = facts.seats;
    this.lastHealth = { ok: facts.answers, version: facts.version, image: await this.imageOf(container), box: null, at: this.now() };
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

  start(): Promise<JobResults["start"]> {
    return this.exclusive(async () => {
      await this.install();
      this.state.saveHome({ ...this.state.home(), desired: "running" });
      await this.bringUp();
      return { home: await this.report() };
    });
  }

  stop(): Promise<JobResults["stop"]> {
    return this.exclusive(async () => {
      await this.install();
      this.state.saveHome({ ...this.state.home(), desired: "stopped" });
      await this.takeDown();
      return { home: await this.report() };
    });
  }

  restart(): Promise<JobResults["restart"]> {
    return this.exclusive(async () => {
      await this.install();
      this.state.saveHome({ ...this.state.home(), desired: "running" });
      await this.takeDown();
      await this.bringUp();
      return { home: await this.report() };
    });
  }

  /**
   * Leaves the image for the server's own updater and waits for its verdict. The updater is deploy/update.sh, the
   * command the owner runs by hand: it copies the data aside, pins the image in the owner's .env, starts it, checks
   * it, and puts the old image and the copy back when the check fails.
   */
  update(jobId: string, image: string): Promise<JobResults["update"]> {
    return this.exclusive(async () => {
      if (!CUSTOMER_HOME_IMAGE.test(image)) throw new JobFailure("image_refused", `${image} is not MausBot's server image pinned by digest. Nothing was changed.`);
      const { container } = await this.install();
      const previous = await this.imageOf(container);
      const dir = this.options.updateDir;
      if (!existsSync(join(dir, UPDATE_FILES.runner))) {
        throw new JobFailure("update_unavailable", "This server has no updater for MausBot to hand an update to. Run the connector's install command again to add it; until then, update with ./update.sh on the server.");
      }
      await this.refuseOlder(image, container);
      const wasRunning = container.State.Running;
      this.begin({ jobId, type: "update", phase: "request", previousImage: previous, nextImage: image, target: null, dataAtRisk: false, wasRunning });
      rmSync(join(dir, UPDATE_FILES.result), { force: true });
      const request = join(dir, UPDATE_FILES.request);
      writeFileSync(`${request}.tmp`, `id=${jobId}\nimage=${image}\n`, { mode: 0o600 });
      renameSync(`${request}.tmp`, request);
      this.phase({ phase: "wait" });
      const code = await this.updaterVerdict(jobId, this.now() + this.updateDeadlineMs);
      this.lastHealth = null;
      if (code !== UPDATE_EXIT.done) {
        this.finish({});
        await this.refreshHealth().catch(() => null);
        throw updateFailure(code, previous);
      }
      this.finish({ image, previousImage: previous, desired: "running" });
      await this.refreshHealth().catch(() => null);
      this.log(`the server's updater moved the home from ${previous ?? "its image"} to ${image}`);
      return { home: await this.report(), previousImage: previous, snapshot: null };
    });
  }

  backup(jobId: string, by: JobSource): Promise<JobResults["backup"]> {
    return this.exclusive(async () => {
      const { container, dataDir } = await this.install();
      const helper = this.helperImage(container);
      await this.ensureRoomForCopy(helper, dataDir);
      const image = await this.imageOf(container);
      const wasRunning = container.State.Running;
      const id = backupId(this.now());
      const target = `${NAMES.backupPrefix}${id}`;
      this.begin({ jobId, type: "backup", phase: "stop", previousImage: image, nextImage: null, target, dataAtRisk: false, wasRunning });
      try {
        await this.takeDown();
        this.phase({ phase: "copy" });
        await this.copy(helper, this.dataMount(dataDir, "/from", true), { Type: "volume", Source: target, Target: "/to" }, "backup", image, by);
      } finally {
        if (wasRunning) await this.bringUp().catch((error) => this.log(`could not start the home again: ${errorText(error)}`));
        this.finish({});
      }
      const { backups } = await this.copies();
      const same = await this.backupsMadeBy(by);
      for (const old of backups.filter((entry) => same.has(entry.id)).slice(BACKUPS_KEPT)) await this.docker.removeVolume(`${NAMES.backupPrefix}${old.id}`);
      return { backup: backups.find((entry) => entry.id === id) ?? { id, kind: "backup", createdAt: this.now(), image } };
    });
  }

  restore(jobId: string, id: string): Promise<JobResults["restore"]> {
    return this.exclusive(async () => {
      const { container, dataDir } = await this.install();
      const helper = this.helperImage(container);
      const source = `${NAMES.backupPrefix}${id}`;
      const volume = await this.docker.volumeInspect(source);
      if (!volume || volume.Labels?.[LABELS.role] !== "backup") throw new JobFailure("not_found", `There is no backup ${id} on this server.`);
      await this.ensureRoomForCopy(helper, dataDir);
      const image = await this.imageOf(container);
      const wasRunning = container.State.Running;
      this.begin({ jobId, type: "restore", phase: "stop", previousImage: image, nextImage: null, target: source, dataAtRisk: false, wasRunning });
      await this.takeDown();
      this.phase({ phase: "snapshot" });
      try {
        await this.copy(helper, this.dataMount(dataDir, "/from", true), { Type: "volume", Source: NAMES.snapshotVolume, Target: "/to" }, "snapshot", image);
      } catch (error) {
        this.finish({});
        if (wasRunning) await this.bringUp().catch(() => {});
        throw error;
      }
      this.phase({ phase: "copy", dataAtRisk: true });
      try {
        await this.overwrite(helper, { Type: "volume", Source: source, Target: "/from", ReadOnly: true }, this.dataMount(dataDir, "/to", false));
      } catch (error) {
        await this.putBackSnapshot(helper, dataDir);
        this.finish({});
        if (wasRunning) await this.bringUp().catch(() => {});
        throw new JobFailure("docker", `Restoring backup ${id} failed (${errorText(error)}); the data is as it was.`);
      }
      this.phase({ phase: "start", dataAtRisk: false });
      this.state.saveHome({ ...this.state.home(), desired: "running" });
      try {
        await this.bringUp();
      } catch (error) {
        throw new JobFailure("unhealthy", `Backup ${id} is back, but the home did not become healthy (${errorText(error)}).`);
      } finally {
        this.finish({});
      }
      return { home: await this.report(), backupId: id };
    });
  }

  /** At start: a job the connector was in the middle of is finished safely, and its result is for the Admin. */
  recover(): Promise<JobReply | null> {
    return this.exclusive(async () => {
      const op = this.state.home().operation;
      if (!op) return null;
      this.log(`the connector restarted during ${op.type} (${op.phase}); finishing it safely`);
      if (op.type === "update") return this.recoverUpdate(op);
      const found = await findInstall(this.docker);
      let outcome = "nothing was changed";
      if (found.ok) {
        const { container, dataDir } = found.install;
        if (op.dataAtRisk) {
          await this.takeDown();
          await this.putBackSnapshot(this.helperImage(container), dataDir);
          outcome = "the data was put back as it was before";
        }
        if (op.type === "backup" && op.target) await this.docker.removeVolume(op.target).catch(() => {});
        if (op.wasRunning) {
          await this.bringUp().catch((error) => this.log(`could not start the home: ${errorText(error)}`));
          outcome += ", and the home was started again";
        }
      }
      this.finish({});
      return { id: op.jobId, ok: false, error: { code: "interrupted", message: `The connector restarted during this ${op.type}; ${outcome}.` } };
    });
  }

  private async recoverUpdate(op: Operation): Promise<JobReply> {
    const code = await this.updaterVerdict(op.jobId, this.now() + 60_000);
    if (code === UPDATE_EXIT.done && op.nextImage) {
      this.finish({ image: op.nextImage, previousImage: op.previousImage, desired: "running" });
      await this.refreshHealth().catch(() => null);
      return { id: op.jobId, ok: true, result: { home: await this.report(), previousImage: op.previousImage, snapshot: null } } as JobReply;
    }
    this.finish({});
    const error: JobError = code === null
      ? { code: "interrupted", message: "The connector restarted during this update. The server's own updater finishes or undoes it by itself; ask for the status to see which version runs." }
      : updateFailure(code, op.previousImage).toJobError();
    return { id: op.jobId, ok: false, error };
  }

  /** The updater's exit code for request `jobId`, or null when it has not answered by `deadline`. */
  private async updaterVerdict(jobId: string, deadline: number): Promise<number | null> {
    const file = join(this.options.updateDir, UPDATE_FILES.result);
    for (;;) {
      let text = "";
      try { text = readFileSync(file, "utf8"); } catch { text = ""; }
      const code = /^code=(\d{1,3})$/m.exec(text)?.[1];
      if (code !== undefined && /^id=(.*)$/m.exec(text)?.[1] === jobId) return Number(code);
      if (this.now() >= deadline) return null;
      await this.sleep(this.pollMs);
    }
  }

  /** Refused before anything is asked of the updater: the Admin may move the server forward, never back. */
  private async refuseOlder(image: string, container: ContainerInfo): Promise<void> {
    if (!(await this.docker.imageInspect(image))) {
      try {
        await this.docker.pull(image);
      } catch (error) {
        throw new JobFailure("pull_failed", `Could not download ${image} (${errorText(error)}). Nothing was changed.`);
      }
    }
    const label = async (ref: string) => (await this.docker.imageInspect(ref).catch(() => null))?.Config?.Labels?.[VERSION_LABEL];
    const refusal = olderVersionRefusal(await label(image), await label(container.Image ?? container.Config.Image));
    if (refusal) throw new JobFailure("older_version", `${refusal} Nothing was changed. To go back to an older version, run ./update.sh on the server yourself.`);
  }

  /** The ids of the backups `by` asked for. A backup made before senders were recorded counts as the owner's. */
  private async backupsMadeBy(by: JobSource): Promise<Set<string>> {
    const volumes = await this.docker.listVolumes({ [LABELS.role]: "backup" });
    return new Set(volumes.filter((volume) => (volume.Labels?.[MADE_BY_LABEL] ?? "local") === by).map((volume) => volume.Name.slice(NAMES.backupPrefix.length)));
  }

  private async container(service: string): Promise<ContainerInfo | null> {
    const [found] = await this.docker.listContainers({ [PROJECT_LABEL]: COMPOSE_PROJECT, [SERVICE_LABEL]: service });
    return found ? this.docker.containerInspect(found.Id) : null;
  }

  private async install(): Promise<Install> {
    const found = await findInstall(this.docker);
    if (!found.ok) throw new JobFailure("no_home", found.why);
    return found.install;
  }

  /** The image the home runs, by digest when Docker knows the digest it was pulled by. */
  private async imageOf(container: ContainerInfo): Promise<string | null> {
    const named = container.Config.Image;
    if (CUSTOMER_HOME_IMAGE.test(named)) return named;
    const digests = (await this.docker.imageInspect(container.Image ?? named).catch(() => null))?.RepoDigests ?? [];
    return digests.find((digest) => CUSTOMER_HOME_IMAGE.test(digest)) ?? named;
  }

  /** The helpers run from the image the home itself runs, so no other image is ever needed for a copy. */
  private helperImage(container: ContainerInfo): string {
    return container.Image ?? container.Config.Image;
  }

  private async read(container: ContainerInfo): Promise<HomeFacts> {
    try {
      return parseHomeReads((await this.docker.exec(container.Id, [...HOME_READS_COMMAND], 30_000)).output);
    } catch {
      return { answers: false, version: null, seats: null };
    }
  }

  /** Caddy shares the home's network, so it stops first and starts only once the home is up again. */
  private async takeDown(): Promise<void> {
    const front = await this.container(FRONT);
    if (front) await this.docker.stopContainer(front.Id, 10);
    const home = await this.container(SERVICE);
    if (home) await this.docker.stopContainer(home.Id, HOME_STOP_TIMEOUT_S);
    this.lastHealth = null;
  }

  private async bringUp(): Promise<void> {
    const home = await this.container(SERVICE);
    if (!home) throw new JobFailure("no_home", "MausBot's container is gone from this server. Run the server's install command again to repair it.");
    const wasRunning = home.State.Running;
    try {
      await this.docker.startContainer(home.Id);
    } catch (error) {
      throw new JobFailure("docker", `Docker could not start the home (${errorText(error)}).`);
    }
    const deadline = this.now() + this.startWindowMs;
    for (;;) {
      const now = await this.docker.containerInspect(home.Id);
      if (!now?.State.Running && !now?.State.Restarting) throw new JobFailure("unhealthy", `The home stopped as it started (exit ${now?.State.ExitCode ?? "unknown"}).`);
      if ((await this.refreshHealth())?.ok) break;
      if (this.now() >= deadline) throw new JobFailure("unhealthy", `The home did not answer within ${Math.round(this.startWindowMs / 60_000)} minutes.`);
      await this.sleep(this.pollMs);
    }
    const front = await this.container(FRONT);
    if (!front) return;
    // A Caddy that kept running while the home restarted is still in the old home's network.
    if (front.State.Running && !wasRunning) await this.docker.stopContainer(front.Id, 10);
    await this.docker.startContainer(front.Id).catch((error) => this.log(`could not start Caddy again: ${errorText(error)}`));
  }

  private dataMount(dataDir: string, target: string, readOnly: boolean): Mount {
    return { Type: "bind", Source: dataDir, Target: target, ...(readOnly ? { ReadOnly: true } : {}) };
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

  private async ensureRoomForCopy(image: string, dataDir: string): Promise<void> {
    const measured = await this.helper(image, [this.dataMount(dataDir, "/data", true)], ["du", "-sk", "/data"], READ_CAPS);
    const used = Number(/^(\d+)/.exec(measured.output.trim())?.[1] ?? NaN) * 1024;
    if (!Number.isFinite(used)) return;
    const free = this.options.diskFree();
    const needed = used * 1.1 + 1e9;
    if (free < needed) throw new JobFailure("disk_full", `There is not enough free disk for a copy of the data: it needs about ${gb(needed)} GB and ${gb(free)} GB are free. Free some space or add a disk.`);
  }

  private async copy(helper: string, from: Mount, to: Mount, kind: "backup" | "snapshot", image: string | null, by?: JobSource): Promise<void> {
    await this.docker.removeVolume(to.Source);
    await this.docker.createVolume(to.Source, { [LABELS.role]: kind, [LABELS.created]: String(this.now()), ...(image ? { [LABELS.image]: image } : {}), ...(by ? { [MADE_BY_LABEL]: by } : {}) });
    const copied = await this.helper(helper, [from, to], ["cp", "-a", "/from/.", "/to/"], COPY_CAPS);
    if (copied.code !== 0) {
      await this.docker.removeVolume(to.Source);
      throw new JobFailure("docker", `Copying the data failed (${lastLine(copied.output)}); nothing was changed.`);
    }
  }

  private async overwrite(helper: string, from: Mount, to: Mount): Promise<void> {
    const wiped = await this.helper(helper, [to], ["find", "/to", "-mindepth", "1", "-delete"], DELETE_CAPS);
    if (wiped.code !== 0) throw new Error(`clearing the data failed (${lastLine(wiped.output)})`);
    const copied = await this.helper(helper, [from, to], ["cp", "-a", "/from/.", "/to/"], COPY_CAPS);
    if (copied.code !== 0) throw new Error(`copying the data back failed (${lastLine(copied.output)})`);
  }

  private async putBackSnapshot(helper: string, dataDir: string): Promise<void> {
    if (!(await this.docker.volumeInspect(NAMES.snapshotVolume))) throw new JobFailure("rollback_failed", "The safety copy of the data is missing; the data was left as it is.");
    await this.overwrite(helper, { Type: "volume", Source: NAMES.snapshotVolume, Target: "/from", ReadOnly: true }, this.dataMount(dataDir, "/to", false));
  }

  private begin(op: Omit<Operation, "startedAt">): void {
    this.state.saveHome({ ...this.state.home(), operation: { ...op, startedAt: this.now() } });
    this.step(op.phase, op.nextImage ? { image: op.nextImage, from: op.previousImage } : undefined);
  }

  private phase(patch: Partial<Operation>): void {
    const record = this.state.home();
    if (!record.operation) return;
    this.state.saveHome({ ...record, operation: { ...record.operation, ...patch } });
    if (patch.phase && patch.phase !== record.operation.phase) this.step(patch.phase);
  }

  private step(step: string, detail?: Record<string, unknown>): void {
    const op = this.state.home().operation;
    if (op) this.options.onStep?.({ id: op.jobId, type: op.type, step, ...(detail ? { detail } : {}) });
  }

  private finish(patch: Partial<HomeRecord>): void {
    this.state.saveHome({ ...this.state.home(), ...patch, operation: null });
  }
}

function updateFailure(code: number | null, previous: string | null): JobFailure {
  const log = "The updater's own account is in .update/update.log in the install's folder.";
  switch (code) {
    case UPDATE_EXIT.rolledBack: return new JobFailure("update_rolled_back", `The new version did not become healthy. The previous version and its data are back. ${log}`, previous ?? undefined);
    case UPDATE_EXIT.rollbackFailed: return new JobFailure("rollback_failed", `The update failed and the previous version did not come back healthy either. ${log}`, previous ?? undefined);
    case UPDATE_EXIT.busy: return new JobFailure("busy", "Another update is already running on this server.");
    case UPDATE_EXIT.notStarted: return new JobFailure("update_not_started", `The server's updater did not start the update, and nothing was changed. ${log}`);
    case UPDATE_EXIT.older: return new JobFailure("older_version", "The server's updater refused the image: it is older than the version running, or names no version. Nothing was changed.");
    case UPDATE_EXIT.missing: return new JobFailure("update_unavailable", "This server has no update.sh in its install folder, so MausBot cannot update it. Add deploy/update.sh there, or update by hand.");
    case null: return new JobFailure("interrupted", "The server's updater did not answer in time. It finishes or undoes an update by itself; ask for the status to see which version runs.");
    default: return new JobFailure("docker", `The server's updater stopped with code ${code}. ${log}`);
  }
}

function copyInfo(id: string, kind: CopyInfo["kind"], labels: Record<string, string> | null): CopyInfo {
  const created = Number(labels?.[LABELS.created]);
  return { id, kind, createdAt: Number.isFinite(created) ? created : 0, image: labels?.[LABELS.image] ?? null };
}
