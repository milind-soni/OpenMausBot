// The private displays the bots' browsers show their windows on when browserEngine.cloudDisplay is on: one Xvnc per
// running browser, started with it and stopped when it exits, so a server with no browser open runs none.
//
// Security: a display has no TCP port. Its RFB socket is a 0600 unix socket in a 0700 folder that only the server's own
// desktop route reads, and X clients need the display's cookie, which only the browser launched on it is given.
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, join } from "node:path";

import { spawnBotWork } from "../../oom-score.ts";
import { policyWrap, type PolicyWrap } from "./policy.ts";
import { MAX_CUT_TEXT } from "./rfb-filter.ts";

export interface DisplaySize {
  width: number;
  height: number;
}

/** A laptop-sized desktop: the panel scales it down, and a page laid out for it reads well there. */
export const DESKTOP_SIZE: DisplaySize = { width: 1280, height: 800 };

/** X display numbers this server picks from, clear of :0 and of the low numbers other tools take. */
export const DISPLAY_RANGE = { first: 20, last: 89 } as const;
const START_ATTEMPTS = 5;
const READY_MS = 10_000;
const STOP_GRACE_MS = 2_000;
const OUTPUT_LIMIT = 8 * 1024;

export interface DesktopDisplay {
  readonly number: number;
  /** The display server's RFB socket. */
  readonly socket: string;
  /** What a program needs to open windows on it. */
  readonly env: { DISPLAY: string; XAUTHORITY: string };
  /** What a Chrome shown on it starts under: the lock-down policy in force for that Chrome alone (policy.ts). */
  readonly wrap: PolicyWrap;
  readonly size: DisplaySize;
  /** Settles when the display server has exited, whichever way. */
  readonly exited: Promise<void>;
  /** Gives the display back; the last holder's release stops it. */
  release(): Promise<void>;
}

type Spawn = (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;

export interface DisplaySupervisorOptions {
  /** Where each display keeps its socket and cookie; a short path, as a unix socket's may not pass about 100 bytes. */
  root: string;
  /** The Xvnc binary, or null where there is none; a function is asked once, the first time a display is wanted. */
  xvnc: string | null | (() => string | null);
  /** bubblewrap, which puts the lock-down policy in force for a display's Chrome alone; null where it cannot run. A
   * function is asked once, the first time a display is wanted, so a server that never wants one never probes. */
  bwrap: string | null | (() => string | null);
  spawn?: Spawn;
  /** Whether something other than this server holds display `n`. */
  taken?: (n: number) => boolean;
  /** Display servers an earlier run of this server left behind. */
  orphans?: (root: string) => number[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Settles once the RFB socket answers. */
  ready?: (socket: string, timeoutMs: number, exited: Promise<void>) => Promise<void>;
  log?: (line: string) => void;
}

/** The Xvnc on PATH, on Linux only. */
export function findXvnc(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "linux") return null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "Xvnc");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/** An X authority file holding one cookie for any host and the given display, as `xauth add` writes it. */
export function xauthority(display: number, cookie: Buffer): Buffer {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    return Buffer.concat([length, value]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(String(display))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(cookie)]);
}

export function xvncArgs(display: number, size: DisplaySize, socket: string, auth: string): string[] {
  return [
    `:${display}`,
    "-geometry", `${size.width}x${size.height}`,
    "-depth", "24",
    "-dpi", "96",
    "-rfbport", "-1",
    "-rfbunixpath", socket,
    "-rfbunixmode", "0600",
    // Safe only because the socket is the server's alone: whoever reaches it is the desktop route.
    "-SecurityTypes", "None",
    "-AlwaysShared",
    // Resized only by the person holding the browser, within limits (rfb-filter.ts); its window follows (views.ts).
    "-AcceptSetDesktopSize=1",
    // The desktop's clipboard never goes to viewers: a page or the bot may have put a secret there.
    "-SendCutText=0",
    "-SendPrimary=0",
    "-MaxCutText", String(MAX_CUT_TEXT),
    "-FrameRate", "30",
    "-nolisten", "tcp",
    "-auth", auth,
    "-desktop", "OpenMausBot",
  ];
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** An X server's lock file names a running process. */
function displayTaken(n: number): boolean {
  try {
    const pid = Number(readFileSync(`/tmp/.X${n}-lock`, "utf8").trim());
    return !Number.isInteger(pid) || pid <= 0 || alive(pid);
  } catch {
    return false;
  }
}

/** Xvnc processes whose RFB socket lies under `root`. */
function leftBehind(root: string): number[] {
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      const at = argv.indexOf("-rfbunixpath");
      if (/(^|\/)Xvnc$/.test(argv[0] ?? "") && at > 0 && argv[at + 1]?.startsWith(`${root}/`)) pids.push(Number(entry));
    } catch {}
  }
  return pids;
}

function socketAnswers(socket: string, timeoutMs: number, exited: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const deadline = setTimeout(() => finish(new Error(`The display did not start within ${timeoutMs} ms.`)), timeoutMs);
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    void exited.then(() => finish(new Error("The display server exited while starting.")));
    const attempt = () => {
      if (done) return;
      const probe = connect(socket);
      probe.once("connect", () => {
        probe.destroy();
        finish(null);
      });
      probe.once("error", () => {
        probe.destroy();
        setTimeout(attempt, 50).unref();
      });
    };
    attempt();
  });
}

interface Running {
  readonly display: DesktopDisplay;
  readonly child: ChildProcess;
  readonly dir: string;
  holders: number;
  stopping: Promise<void> | null;
}

const children = new Set<ChildProcess>();
let exitHook = false;

/** Starts and stops the displays; nothing it started outlives the server. */
export class DisplaySupervisor {
  readonly #options: DisplaySupervisorOptions;
  readonly #running = new Map<string, Running>();
  readonly #starting = new Map<string, Promise<Running>>();
  /** Display numbers a start of this server holds, from the moment it picks one until that display is gone. */
  readonly #claimed = new Set<number>();
  #swept = false;
  #probed: { bwrap: string | null } | null = null;
  #found: { xvnc: string | null } | null = null;

  constructor(options: DisplaySupervisorOptions) {
    this.#options = options;
  }

  /** Security: with no way to put the policy in force for its Chrome alone, no browser gets a display. */
  get available(): boolean {
    return this.#xvnc() !== null && this.#bwrap() !== null;
  }

  #xvnc(): string | null {
    const xvnc = this.#options.xvnc;
    if (typeof xvnc !== "function") return xvnc;
    this.#found ??= { xvnc: xvnc() };
    return this.#found.xvnc;
  }

  #bwrap(): string | null {
    const bwrap = this.#options.bwrap;
    if (typeof bwrap !== "function") return bwrap;
    this.#probed ??= { bwrap: bwrap() };
    return this.#probed.bwrap;
  }

  /** The numbers of the displays running now. */
  numbers(): number[] {
    return [...this.#running.values()].map((running) => running.display.number);
  }

  /** A display for the browser of profile `key`: its running one, else a new one. */
  async acquire(key: string, size: DisplaySize = DESKTOP_SIZE, fileRoots: readonly string[] = []): Promise<DesktopDisplay> {
    for (;;) {
      const running = this.#running.get(key);
      if (running?.stopping) {
        await running.stopping;
        continue;
      }
      if (running) {
        running.holders++;
        return this.#handle(key, running);
      }
      const starting = this.#starting.get(key) ?? this.#start(key, size, fileRoots).finally(() => this.#starting.delete(key));
      this.#starting.set(key, starting);
      const started = await starting;
      if (this.#running.get(key) === started && !started.stopping) {
        started.holders++;
        return this.#handle(key, started);
      }
    }
  }

  /** Stops every display; the server is shutting down. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((key) => this.#stop(key)));
  }

  #handle(key: string, running: Running): DesktopDisplay {
    let released = false;
    return {
      ...running.display,
      release: async () => {
        if (released) return;
        released = true;
        running.holders--;
        if (running.holders <= 0 && this.#running.get(key) === running) await this.#stop(key);
      },
    };
  }

  #sweep(): void {
    if (this.#swept) return;
    this.#swept = true;
    const kill = this.#options.kill ?? ((pid, signal) => process.kill(pid, signal));
    for (const pid of (this.#options.orphans ?? leftBehind)(this.#options.root)) {
      try {
        kill(pid, "SIGKILL");
        this.#options.log?.(`browser display: stopped a display server an earlier run left (pid ${pid})`);
      } catch {}
    }
  }

  /** The first number neither this server nor anything else holds, claimed before anything awaits. */
  #claim(skip: ReadonlySet<number>): number | null {
    const taken = this.#options.taken ?? displayTaken;
    for (let n = DISPLAY_RANGE.first; n <= DISPLAY_RANGE.last; n++) {
      if (this.#claimed.has(n) || skip.has(n) || taken(n)) continue;
      this.#claimed.add(n);
      return n;
    }
    return null;
  }

  async #start(key: string, size: DisplaySize, fileRoots: readonly string[]): Promise<Running> {
    const xvnc = this.#xvnc();
    if (!xvnc) throw new Error("This server has no display for a browser window: Xvnc is not installed.");
    const bwrap = this.#bwrap();
    if (!bwrap) throw new Error("This server cannot keep a browser window's Chrome locked down: bubblewrap cannot run here.");
    this.#sweep();
    mkdirSync(this.#options.root, { recursive: true, mode: 0o700 });
    let lastError: Error | null = null;
    const tried = new Set<number>();
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      const number = this.#claim(tried);
      if (number === null) break;
      tried.add(number);
      try {
        const running = await this.#launch(xvnc, bwrap, number, size, fileRoots);
        this.#running.set(key, running);
        void running.display.exited.then(() => {
          if (this.#running.get(key) === running) this.#running.delete(key);
          rmSync(running.dir, { recursive: true, force: true });
          this.#claimed.delete(number);
        });
        return running;
      } catch (error) {
        this.#claimed.delete(number);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error("No display number is free for a browser window.");
  }

  async #launch(xvnc: string, bwrap: string, number: number, size: DisplaySize, fileRoots: readonly string[]): Promise<Running> {
    const dir = join(this.#options.root, `d${number}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const socket = join(dir, "rfb");
    const auth = join(dir, "Xauthority");
    writeFileSync(auth, xauthority(number, randomBytes(16)), { mode: 0o600 });
    const spawn = this.#options.spawn ?? ((file, args, options) => spawnProcess(file, args, { ...options, stdio: ["ignore", "ignore", "pipe"] }));
    const child = spawnBotWork(() => spawn(xvnc, xvncArgs(number, size, socket, auth), { env: process.env }));
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT); });
    const exited = new Promise<void>((resolve) => {
      // "close" comes after the error output was read.
      child.once("close", () => resolve());
      child.once("error", (error) => {
        output += `${error.message}\n`;
        resolve();
      });
    });
    children.add(child);
    void exited.then(() => children.delete(child));
    if (!exitHook) {
      exitHook = true;
      process.once("exit", () => { for (const running of children) try { running.kill("SIGKILL"); } catch {} });
    }
    try {
      await (this.#options.ready ?? socketAnswers)(socket, READY_MS, exited);
    } catch (error) {
      try { child.kill("SIGKILL"); } catch {}
      await exited;
      rmSync(dir, { recursive: true, force: true });
      const reason = output.trim().split("\n").slice(-3).join(" ");
      throw new Error(`${error instanceof Error ? error.message : String(error)}${reason ? ` ${reason}` : ""}`);
    }
    const display: DesktopDisplay = {
      number,
      socket,
      env: { DISPLAY: `:${number}`, XAUTHORITY: auth },
      wrap: policyWrap(bwrap, join(dir, "policy"), fileRoots),
      size,
      exited,
      release: async () => {},
    };
    return { display, child, dir, holders: 0, stopping: null };
  }

  #stop(key: string): Promise<void> {
    const running = this.#running.get(key);
    if (!running) return Promise.resolve();
    running.stopping ??= (async () => {
      const { child } = running;
      try { child.kill("SIGTERM"); } catch {}
      const late = await Promise.race([running.display.exited.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STOP_GRACE_MS).unref())]);
      if (late) {
        try { child.kill("SIGKILL"); } catch {}
        await running.display.exited;
      }
      if (this.#running.get(key) === running) this.#running.delete(key);
      rmSync(running.dir, { recursive: true, force: true });
      this.#claimed.delete(running.display.number);
    })();
    return running.stopping;
  }
}
