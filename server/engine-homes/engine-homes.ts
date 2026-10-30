// The engine homes of a Team Cloud at run time. A turn's spawns run inside its conversation (`within`, set around each
// adapter's sendTurn and keep-warm ping), and procs.ts asks `forSpawn` for the home of that conversation's audience. Off a
// Team Cloud nothing is started and every spawn keeps the server's HOME.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import type { Audience } from "../audience.ts";
import type { ProviderInstance } from "../contracts.ts";
import { audienceHome, audienceHomeKey, audienceHomes, homedSpawn, type HomedSpawn } from "./layout.ts";
import { migrateEngineHomes, type MigrationResult, type MigrationThread } from "./migrate.ts";
import { syncSignIns } from "./sign-ins.ts";

export interface EngineHomesSetup {
  dataDir: string;
  serverHome?: string;
  audienceOf(threadId: string): Audience;
  /** Every conversation the server resumes, for the first start's move. */
  threads(): Iterable<MigrationThread>;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export class EngineHomes {
  #setup: (EngineHomesSetup & { serverHome: string }) | null = null;
  #migration: MigrationResult | null = null;
  readonly #thread = new AsyncLocalStorage<string>();

  start(setup: EngineHomesSetup): void {
    this.#setup = { ...setup, serverHome: setup.serverHome ?? homedir() };
    this.#migration = null;
  }

  stop(): void {
    this.#setup = null;
  }

  active(): boolean {
    return this.#setup !== null;
  }

  /** Runs `start` with what it spawns counted as this conversation's. */
  within<T>(threadId: string, start: () => T): T {
    return this.#setup ? this.#thread.run(threadId, start) : start();
  }

  /** The audience key of the conversation the caller runs in, so engines never share a process across audiences. */
  scope(): string | null {
    const threadId = this.#setup ? this.#thread.getStore() : undefined;
    return threadId === undefined ? null : audienceHomeKey(this.#setup!.audienceOf(threadId));
  }

  /** The first spawn after a start moves what the engines kept in the server's HOME (migrate.ts). */
  migrate(): MigrationResult | null {
    const setup = this.#setup;
    if (!setup) return null;
    if (this.#migration) return this.#migration;
    try {
      this.#migration = migrateEngineHomes({ dataDir: setup.dataDir, serverHome: setup.serverHome, env: setup.env ?? process.env, threads: setup.threads, audienceOf: setup.audienceOf });
      if (this.#migration.ran || this.#migration.swept) {
        (setup.log ?? console.log)(`engine homes: moved ${this.#migration.moved} session files to their conversations, held ${this.#migration.held}, deleted ${this.#migration.swept} held folders past their time`);
      }
    } catch (error) {
      this.#migration = { ran: false, moved: 0, held: 0, swept: 0 };
      (setup.log ?? console.warn)(`engine homes: the move from the server's home failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.#migration;
  }

  /** On a Team Cloud, inside a conversation: the spawn with HOME and the engines' folders in its audience's home, the
   * home made, and the team's sign-ins in it. Null otherwise. */
  forSpawn(env: Record<string, string | undefined>): HomedSpawn | null {
    const setup = this.#setup;
    const threadId = setup ? this.#thread.getStore() : undefined;
    if (!setup || threadId === undefined) return null;
    this.migrate();
    const home = audienceHome(setup.dataDir, setup.audienceOf(threadId));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const homed = homedSpawn(env, { dataDir: setup.dataDir, serverHome: setup.serverHome, home });
    for (const folder of homed.folders) mkdirSync(folder, { recursive: true, mode: 0o700 });
    const others = audienceHomes(setup.dataDir).filter((dir) => dir !== home);
    syncSignIns(homed.shared, (target) => others.map((dir) => join(dir, relative(home, target))));
    return homed;
  }
}

export const engineHomes = new EngineHomes();

/** On a Team Cloud, every turn and keep-warm ping of this instance runs inside its conversation. */
export function withEngineHomes(instance: ProviderInstance, homes: EngineHomes = engineHomes): ProviderInstance {
  if (!homes.active()) return instance;
  const adapter = instance.adapter;
  const warm = adapter.cacheKeepWarm;
  (instance as { adapter: ProviderInstance["adapter"] }).adapter = {
    ...adapter,
    sendTurn: (input) => homes.within(input.threadId, () => adapter.sendTurn(input)),
    ...(warm ? { cacheKeepWarm: { ...warm, ping: (threadId, options) => homes.within(threadId, () => warm.ping(threadId, options)) } } : {}),
  };
  return instance;
}
