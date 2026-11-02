// The connector's state volume: small JSON files, each written whole (temp file, then rename) and readable by root only,
// in a folder only root may enter. The agent token and the home's environment live here and nowhere else.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentRecord {
  version: 1;
  admin: string;
  serverId: string;
  cloudId: string;
  agentToken: string;
  enrolledAt: number;
}

/** A step of a job that changes the home or its data, written before the step starts, so a restart can finish it. */
export interface Operation {
  jobId: string;
  type: "start" | "update" | "restore" | "import-disk" | "backup" | "export-disk";
  phase: string;
  previousImage: string | null;
  nextImage: string | null;
  /** What the job makes or reads besides the home: a backup's volume, an archive's file name in the state folder. */
  target: string | null;
  /** The safety copy holds the data as it was: a restart while this is true puts it back. */
  dataAtRisk: boolean;
  /** The home was running before the job and should run after it. */
  wasRunning: boolean;
  startedAt: number;
}

export interface HomeRecord {
  version: 1;
  /** What the Admin asked for last; the connector keeps the home that way. */
  desired: "running" | "stopped";
  image: string | null;
  /** The image before the last update, kept on the server so a rollback needs no download. */
  previousImage: string | null;
  operation: Operation | null;
}

export interface StatusRecord {
  connected: boolean;
  unauthorized: boolean;
  lastConnectedAt: number | null;
  lastHeartbeatAt: number | null;
  lastError: string | null;
}

export interface SelfUpdateRecord {
  jobId: string;
  from: string | null;
  to: string;
  /** The id of the container that started the update; the new one removes it once it has connected. */
  previousContainer: string;
  candidateContainer: string;
  /** The new connector's MAUSBOT_INSTANCE: how each side knows which one it is. */
  candidateInstance: string;
  deadline: number;
}

const FILES = {
  agent: "agent.json",
  home: "home.json",
  env: "home-env.json",
  status: "status.json",
  selfUpdate: "self-update.json",
} as const;

export class StateStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  read<T>(name: string): T | null {
    const file = this.path(name);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      throw new Error(`The connector's state file ${name} is unreadable. Run the install command again to repair it.`);
    }
  }

  write(name: string, value: unknown): void {
    const file = this.path(name);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    renameSync(temp, file);
  }

  remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }

  agent(): AgentRecord | null {
    return this.read<AgentRecord>(FILES.agent);
  }

  saveAgent(record: AgentRecord): void {
    this.write(FILES.agent, record);
  }

  home(): HomeRecord {
    return this.read<HomeRecord>(FILES.home) ?? { version: 1, desired: "stopped", image: null, previousImage: null, operation: null };
  }

  saveHome(record: HomeRecord): void {
    this.write(FILES.home, record);
  }

  homeEnv(): Record<string, string> | null {
    return this.read<Record<string, string>>(FILES.env);
  }

  saveHomeEnv(env: Record<string, string>): void {
    this.write(FILES.env, env);
  }

  status(): StatusRecord {
    return this.read<StatusRecord>(FILES.status) ?? { connected: false, unauthorized: false, lastConnectedAt: null, lastHeartbeatAt: null, lastError: null };
  }

  saveStatus(patch: Partial<StatusRecord>): void {
    this.write(FILES.status, { ...this.status(), ...patch });
  }

  selfUpdate(): SelfUpdateRecord | null {
    return this.read<SelfUpdateRecord>(FILES.selfUpdate);
  }

  saveSelfUpdate(record: SelfUpdateRecord): void {
    this.write(FILES.selfUpdate, record);
  }

  /** Decides a self-update once: the first of the two connectors to rename the record wins; the other learns which. */
  settleSelfUpdate(outcome: "confirmed" | "aborted"): "confirmed" | "aborted" {
    try {
      renameSync(this.path(FILES.selfUpdate), this.path(`self-update.${outcome}.json`));
      return outcome;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return existsSync(this.path("self-update.confirmed.json")) ? "confirmed" : "aborted";
    }
  }

  selfUpdateOutcome(): { outcome: "confirmed" | "aborted"; record: SelfUpdateRecord } | null {
    for (const outcome of ["confirmed", "aborted"] as const) {
      const record = this.read<SelfUpdateRecord>(`self-update.${outcome}.json`);
      if (record) return { outcome, record };
    }
    return null;
  }

  clearSelfUpdateOutcome(): void {
    this.remove("self-update.confirmed.json");
    this.remove("self-update.aborted.json");
  }
}
