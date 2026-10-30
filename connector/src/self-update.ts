// The connector replaces itself the way it updates the home: by digest, and keeping the running one until the new one
// has shown it works. The new connector proves it by connecting to the Admin; then it answers the job, removes the old
// container and takes its name. If it has not within the deadline, the old one removes it and carries on. Each side
// settles the outcome with one atomic rename in the state volume, so they can never both win.
import { randomUUID } from "node:crypto";

import type { ContainerInfo, ContainerSpec, Docker } from "./docker.ts";
import { errorText, type Log } from "./log.ts";
import type { ConnectorIdentity, Job, JobReply } from "./protocol.ts";
import { LABELS, NAMES } from "./settings.ts";
import type { SelfUpdateRecord, StateStore } from "./state.ts";

export const SELF_UPDATE_DEADLINE_MS = 3 * 60_000;
const INSTANCE_ENV = "MAUSBOT_INSTANCE";
const IMAGE_ENV = "MAUSBOT_CONNECTOR_IMAGE";

export interface SelfUpdateDeps {
  docker: Docker;
  state: StateStore;
  log: Log;
  /** This connector's MAUSBOT_INSTANCE, also its container's instance label. */
  instance: string;
  identity: () => ConnectorIdentity;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  pollMs?: number;
}

/** The container a connector process runs in, found by the instance label install.sh (or a self-update) gave it. */
export async function ownContainer(docker: Docker, instance: string): Promise<ContainerInfo | null> {
  const [found] = await docker.listContainers({ [LABELS.instance]: instance });
  return found ? docker.containerInspect(found.Id) : null;
}

const HOST_CONFIG_KEYS = ["Binds", "Mounts", "NetworkMode", "RestartPolicy", "SecurityOpt", "CapAdd", "CapDrop", "ReadonlyRootfs", "Tmpfs", "Init", "LogConfig"] as const;

/**
 * The same container as `current`, on `image`, with a new instance id. Only the connector's own MAUSBOT_ settings carry
 * over: the rest of an inspected environment is the old image's own ENV, which the new image sets for itself.
 */
export function successorSpec(current: ContainerInfo, image: string, instance: string): ContainerSpec {
  const env = (current.Config.Env ?? []).filter((entry) => entry.startsWith("MAUSBOT_") && !entry.startsWith(`${INSTANCE_ENV}=`) && !entry.startsWith(`${IMAGE_ENV}=`));
  const hostConfig: Record<string, unknown> = {};
  for (const key of HOST_CONFIG_KEYS) if (current.HostConfig[key] !== undefined && current.HostConfig[key] !== null) hostConfig[key] = current.HostConfig[key];
  return {
    Image: image,
    Env: [...env, `${INSTANCE_ENV}=${instance}`, `${IMAGE_ENV}=${image}`],
    ...(current.Config.Cmd ? { Cmd: current.Config.Cmd } : {}),
    Labels: { ...current.Config.Labels, [LABELS.instance]: instance, [LABELS.role]: "connector" },
    HostConfig: hostConfig as ContainerSpec["HostConfig"],
  };
}

export class SelfUpdater {
  private readonly deps: SelfUpdateDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: SelfUpdateDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private fail(job: Job<"self-update">, message: string): JobReply {
    return { id: job.id, ok: false, error: { code: "self_update_failed", message } };
  }

  /**
   * In the running connector. `pause` stops its connection so the new one can take it; `resume` re-opens it after a
   * failure. Null: the new connector took over, answered the job, and removes this one.
   */
  async run(job: Job<"self-update">, agent: { pause(): void; resume(): void }): Promise<JobReply | null> {
    const { docker, state, log } = this.deps;
    const image = job.args.image;
    const self = await ownContainer(docker, this.deps.instance);
    if (!self) return this.fail(job, "The connector cannot find its own container, so it cannot replace itself. Run the install command again.");
    if (self.Config.Image === image) return { id: job.id, ok: true, result: { connector: this.deps.identity() } };
    try {
      await docker.pull(image);
    } catch (error) {
      return this.fail(job, `Could not download ${image} (${errorText(error)}). The connector was not changed.`);
    }
    const instance = randomUUID();
    const record: SelfUpdateRecord = {
      jobId: job.id, from: self.Config.Image, to: image, previousContainer: self.Id, candidateContainer: NAMES.connectorNext,
      deadline: this.now() + (this.deps.deadlineMs ?? SELF_UPDATE_DEADLINE_MS), candidateInstance: instance,
    };
    state.clearSelfUpdateOutcome();
    await docker.removeContainer(NAMES.connectorNext);
    state.saveSelfUpdate(record);
    try {
      await docker.createContainer(NAMES.connectorNext, successorSpec(self, image, instance));
      agent.pause();
      await docker.startContainer(NAMES.connectorNext);
    } catch (error) {
      state.settleSelfUpdate("aborted");
      state.clearSelfUpdateOutcome();
      await docker.removeContainer(NAMES.connectorNext).catch(() => {});
      agent.resume();
      return this.fail(job, `The new connector could not be started (${errorText(error)}). The connector was not changed.`);
    }
    log(`started the new connector on ${image}; waiting for it to connect`);
    const outcome = await this.awaitOutcome(record);
    if (outcome === "confirmed") {
      log("the new connector took over; this one stops");
      await docker.stopContainer(self.Id, 10).catch(() => {});
      return null;
    }
    await docker.removeContainer(NAMES.connectorNext).catch(() => {});
    state.clearSelfUpdateOutcome();
    agent.resume();
    return this.fail(job, `The new connector did not connect to MausBot within ${Math.round((this.deps.deadlineMs ?? SELF_UPDATE_DEADLINE_MS) / 60_000)} minutes; kept this one.`);
  }

  private async awaitOutcome(record: SelfUpdateRecord): Promise<"confirmed" | "aborted"> {
    for (;;) {
      const settled = this.deps.state.selfUpdateOutcome();
      if (settled) return settled.outcome;
      if (this.now() >= record.deadline) return this.deps.state.settleSelfUpdate("aborted");
      await this.sleep(this.deps.pollMs ?? 2_000);
    }
  }

  /**
   * At start, in either connector. The new one (its instance is the record's candidate) waits to be connected, then
   * settles the update as confirmed. The old one, started again mid-update (a reboot), waits for the outcome, and once
   * the new one has won it only waits to be removed. Returns what this process should do.
   */
  async atStart(connected: () => Promise<boolean>): Promise<{ role: "none" } | { role: "candidate"; reply: JobReply } | { role: "superseded" }> {
    const { docker, state, log } = this.deps;
    const record = state.selfUpdate();
    if (!record) {
      const settled = state.selfUpdateOutcome();
      if (settled?.outcome === "confirmed" && settled.record.candidateInstance !== this.deps.instance) {
        // Superseded only while the connector that won runs; a record it never cleared means nothing on its own.
        if ((await ownContainer(docker, settled.record.candidateInstance))?.State.Running) return { role: "superseded" };
        state.clearSelfUpdateOutcome();
        return { role: "none" };
      }
      if (settled?.outcome === "confirmed") await this.finishTakeover();
      else if (settled) state.clearSelfUpdateOutcome();
      return { role: "none" };
    }
    if (record.candidateInstance === this.deps.instance) {
      const outcome = state.settleSelfUpdate((await connected()) ? "confirmed" : "aborted");
      if (outcome !== "confirmed") {
        log("the update of the connector was called off; this one stops");
        return { role: "superseded" };
      }
      await this.finishTakeover();
      return { role: "candidate", reply: { id: record.jobId, ok: true, result: { connector: this.deps.identity() } } };
    }
    if ((await this.awaitOutcome(record)) === "confirmed") return { role: "superseded" };
    await docker.removeContainer(record.candidateContainer).catch(() => {});
    state.clearSelfUpdateOutcome();
    log("the new connector never connected; this one carries on");
    return { role: "none" };
  }

  /**
   * In the new connector once the update is confirmed: remove the old container and take the usual name. The confirmed
   * record stays until the next update, so an old connector that is still polling, or starts again, reads the outcome.
   */
  private async finishTakeover(): Promise<void> {
    const { docker, state, log } = this.deps;
    const settled = state.selfUpdateOutcome();
    if (!settled || settled.outcome !== "confirmed" || settled.record.candidateInstance !== this.deps.instance) return;
    const self = await ownContainer(docker, this.deps.instance);
    if (!self) return;
    try {
      if (settled.record.previousContainer !== self.Id) await docker.removeContainer(settled.record.previousContainer);
      if (self.Name.replace(/^\//, "") !== NAMES.connector) await docker.renameContainer(self.Id, NAMES.connector);
      log(`the connector now runs ${settled.record.to}`);
    } catch (error) {
      log(`could not finish replacing the old connector yet: ${errorText(error)}`);
    }
  }
}
