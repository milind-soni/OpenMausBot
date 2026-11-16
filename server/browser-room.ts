import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boxMemory } from "./box-memory.ts";

/** One open browser with one page in the server image (Chromium 156, agent-browser 0.37.0): 13 processes, about 160
 * threads (each counts against a pids limit) and about 350 MB. */
const BROWSER_THREADS = 160;
const BROWSER_BYTES = 400 * 1024 * 1024;
/** The part of the server's limits that browsers may fill; engines and their tools need the rest. */
const BROWSER_SHARE = 0.4;
const MOST_BROWSERS = 16;
const ROOM_WAIT_MS = 30_000;

type Read = (path: string) => string | null;
const readText: Read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };

/** The tightest task limit over this process's own cgroup and its parents (a container's --pids-limit, a systemd
 * TasksMax): cgroup v2 `pids.max`, or v1's under the pids controller. Null with no limit, and off Linux. */
export function pidsLimit(read: Read = readText): number | null {
  const membership = read("/proc/self/cgroup");
  if (membership === null) return null;
  const v2 = /^0::(\/.*)$/m.exec(membership)?.[1];
  const v1 = /^\d+:(?:[^:]*,)?pids(?:,[^:]*)?:(\/.*)$/m.exec(membership)?.[1];
  const root = v2 !== undefined ? "/sys/fs/cgroup" : "/sys/fs/cgroup/pids";
  let limit: number | null = null;
  for (let at = (v2 ?? v1 ?? "/").trim(); ; at = dirname(at)) {
    const value = Number(read(join(root, at, "pids.max"))?.trim());
    if (Number.isInteger(value) && value > 0) limit = Math.min(limit ?? value, value);
    if (at === "/" || at === ".") return limit;
  }
}

/** How many agent-browser browsers run at once: `OMB_BROWSER_MAX_RUNNING`, else what fits in the browsers' share of the
 * task limit and of the memory this server may use. */
export function browserRoomSize(limits: { override?: string; pids: number | null; memoryBytes: number }): number {
  const override = Number(limits.override);
  if (Number.isInteger(override) && override > 0) return override;
  const byMemory = Math.floor((limits.memoryBytes * BROWSER_SHARE) / BROWSER_BYTES);
  const byTasks = limits.pids === null ? MOST_BROWSERS : Math.floor((limits.pids * BROWSER_SHARE) / BROWSER_THREADS);
  return Math.max(1, Math.min(MOST_BROWSERS, byMemory, byTasks));
}

let size: number | undefined;
export function defaultBrowserRoomSize(env: NodeJS.ProcessEnv = process.env): number {
  size ??= browserRoomSize({ override: env.OMB_BROWSER_MAX_RUNNING, pids: pidsLimit(), memoryBytes: boxMemory().bytes });
  return size;
}

export interface BrowserRoomOptions {
  max(): number;
  /** How long the session's browser has sat unused (ms) when it may be closed now; null while a call, a person, a view
   * or a running turn that could not get the same browser back has it. */
  spare(session: string): number | null;
  /** Closes an unused browser; true once it is gone. */
  close(session: string): Promise<boolean>;
  waitMs?: number;
  pollMs?: number;
}

/** Counts the browsers agent-browser runs for this server. A browser over the limit starts once the least recently used
 * spare one is closed; with none to close its call waits, then is told why it cannot start. */
export class BrowserRoom {
  readonly #open = new Set<string>();
  readonly #options: BrowserRoomOptions;

  constructor(options: BrowserRoomOptions) { this.#options = options; }

  get open(): number { return this.#open.size; }

  /** Null once `session` may run a browser; otherwise the refusal for the bot. */
  async enter(session: string, deadline: number): Promise<string | null> {
    const until = Math.min(deadline, Date.now() + (this.#options.waitMs ?? ROOM_WAIT_MS));
    for (;;) {
      if (this.#open.has(session)) return null;
      const others = [...this.#open];
      if (others.length < Math.max(1, this.#options.max())) {
        this.#open.add(session);
        return null;
      }
      const spare = others.flatMap((other) => { const idle = this.#options.spare(other); return idle === null ? [] : [{ other, idle }]; })
        .sort((a, b) => b.idle - a.idle)[0];
      if (spare && await this.#options.close(spare.other).catch(() => false)) {
        this.#open.delete(spare.other);
        continue;
      }
      if (Date.now() >= until) return `${others.length} browsers are already open on this computer, the most it runs at once. Wait for another bot to finish with its browser, then try again.`;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.#options.pollMs ?? 500, Math.max(1, until - Date.now()))));
    }
  }

  left(session: string): void { this.#open.delete(session); }
}

type ListedSpec = { command: string; args: readonly string[] };
const listKey = (spec: ListedSpec) => JSON.stringify([spec.command, ...spec.args]);

/** agent-browser's tool list follows from its binary and arguments, never from the session, so one answer serves every
 * session and listing tools starts no `agent-browser mcp` process of its own. */
export class SharedToolLists {
  readonly #lists = new Map<string, Promise<unknown>>();
  readonly #known = new Map<string, unknown>();

  /** `check` runs first on every ask, as a session's own connection would check its launch settings. */
  get(spec: ListedSpec, load: () => Promise<unknown>, check?: () => void): Promise<unknown> {
    try { check?.(); } catch (error) { return Promise.reject(error); }
    const key = listKey(spec);
    let list = this.#lists.get(key);
    if (!list) {
      list = load().then((result) => {
        if (Array.isArray((result as { tools?: unknown } | null)?.tools)) this.#known.set(key, result);
        else this.#lists.delete(key);
        return result;
      }, (error: unknown) => { this.#lists.delete(key); throw error; });
      this.#lists.set(key, list);
    }
    return list;
  }

  /** The list already read for these launch settings, if any. */
  known(spec: ListedSpec): unknown { return this.#known.get(listKey(spec)); }
}
