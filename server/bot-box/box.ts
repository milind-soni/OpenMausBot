// The bot box runtime: one per server. Decides once at boot whether turns are boxed (detect.ts), opens the two gates the
// boxes reach through unix sockets (egress-gate.ts, harness-gate.ts), and wraps each bot spawn (server/procs.ts spawnCli
// with owner "bot") in bubblewrap by the plan (plan.ts). Nothing here changes a spawn when the box is off: the command,
// its arguments and its environment go through untouched, so every host that is not a Cloud home behaves as before.
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { engineInstallRoots } from "../engine-roots.ts";
import { SERVER_ROOT, resolveProxy } from "../proxy-paths.ts";
import { bridgedCommand, type BridgeTools } from "./bridge.ts";
import { brokerRewrite } from "./broker-env.ts";
import { openCredentialBroker, type BrokerGrant, type CredentialBroker } from "./broker.ts";
import { detectBox, type BoxDetection, type BoxKind } from "./detect.ts";
import { openBoxEgressGate, type BoxEgressGate } from "./egress-gate.ts";
import { boxEnvironment } from "./env.ts";
import { openHarnessGate, type HarnessGate } from "./harness-gate.ts";
import { DENIED_SYSCALLS, seccompBytes, seccompSupported } from "./seccomp.ts";
import { bwrapArgs, planBox, taskWorkspaceIds, type BoxBridge, type BoxPlan, type BoxRequest, type BoxSetup } from "./plan.ts";

/** The loopback port inside a box that reaches the egress gate. The harness gate sits at the server's own port. */
export const BOX_EGRESS_PORT = 3128;
/** The loopback port inside a box that reaches the credential broker. */
export const BOX_BROKER_PORT = 18080;
/** The descriptor the box reads its seccomp filter from: the first after stdio. */
export const BOX_SECCOMP_FD = 3;
export const BOX_BRIDGE_SCRIPT = resolveProxy("bot-box/box-bridge");
export const BOX_PROBE_SCRIPT = resolveProxy("bot-box/box-probe");

export interface WrappedSpawn {
  command: string;
  args: string[];
  env: Record<string, string>;
  plan: BoxPlan;
  /** The broker token this process got, or null; `release` revokes it (the caller does so when the process exits). */
  token: string | null;
  release(): void;
  /** Keys left raw in the environment because their CLI takes no base URL. */
  unbrokered: string[];
  /** Descriptors to hand the child after stdio (the seccomp filter), in order from 3; the caller closes them after the spawn. */
  extraFds: number[];
}

/** What the box runtime offers the broker's callers: mint a conversation-bound grant (an MCP server's headers). */
export interface BoxBroker {
  port: number;
  mintForThread: CredentialBroker["mintForThread"];
  touchThread: CredentialBroker["touchThread"];
  revokeThread: CredentialBroker["revokeThread"];
  lookup: CredentialBroker["lookup"];
}

export interface RunnerOptions {
  bwrap: string;
  bridge: BridgeTools;
  setup: BoxSetup;
  /** Names refused in the box's environment whatever the allow-list says: the workspace credentials. */
  denyEnv: ReadonlySet<string>;
  egressPort?: number;
  /** The seccomp filter file to hand each box on BOX_SECCOMP_FD; none loads no filter. */
  seccompFile?: string | null;
  /** The broker to mint per-process tokens with; none leaves keys in the environment. */
  broker?: { port: number; mintForProcess(input: { botId?: string | null; threadId?: string | null; grants: Record<string, BrokerGrant> }): { token: string }; revoke(token: string): void } | null;
}

/** Wraps spawns for one setup (the server's, or a self-check fixture's). */
export class BoxRunner {
  private readonly options: RunnerOptions;
  /** Paths a conversation's turns may write besides the bot's own folder (a member's or a room's memory layer on a Team Cloud). */
  private readonly lent = new Map<string, readonly string[]>();

  constructor(options: RunnerOptions) { this.options = options; }

  get setup(): BoxSetup { return this.options.setup; }

  /** Lends `rw` paths to every box of this conversation until `lend` is called again with none. */
  lend(botId: string, threadId: string, rw: readonly string[]): void {
    if (rw.length) this.lent.set(`${botId}/${threadId}`, [...rw]); else this.lent.delete(`${botId}/${threadId}`);
  }

  lentTo(botId: string, threadId: string): readonly string[] {
    return this.lent.get(`${botId}/${threadId}`) ?? [];
  }

  wrap(given: BoxRequest): WrappedSpawn {
    const ids = given.cwd ? taskWorkspaceIds(given.cwd, this.options.setup.dataDir) : null;
    const lent = ids ? this.lentTo(ids.botId, ids.threadId) : [];
    const request: BoxRequest = lent.length ? { ...given, rw: [...(given.rw ?? []), ...lent] } : given;
    const extraFds: number[] = [];
    const seccomp = this.options.seccompFile && !this.options.setup.mutate?.has("no-seccomp") ? this.options.seccompFile : null;
    if (seccomp) extraFds.push(openSync(seccomp, "r"));
    const plan = planBox({ ...this.options.setup, seccompFd: seccomp ? BOX_SECCOMP_FD : undefined }, request);
    const mutate = this.options.setup.mutate;
    const env = mutate?.has("env-all")
      ? Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      : boxEnvironment(request.env, this.options.denyEnv, new Set(request.allowEnv ?? []));
    if (plan.net === "isolated") {
      const proxy = `http://127.0.0.1:${this.options.egressPort ?? BOX_EGRESS_PORT}`;
      for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[name] = proxy;
      // Node's env proxy matches an IPv6 host only bracketed; curl and the engines take the plain forms.
      for (const name of ["NO_PROXY", "no_proxy"]) env[name] = "127.0.0.1,localhost,::1,[::1]";
    }
    const bridges = plan.net === "isolated" ? this.options.setup.bridges : [];
    const inner = bridgedCommand(this.options.bridge, bridges, request.command, request.args);
    const brokered = this.broker(env, plan, request);
    const vouched = (request.allowEnv ?? []).filter((name) => /(?:KEY|TOKEN|SECRET)$/.test(name) && brokered.env[name] !== undefined && brokered.env[name] === request.env[name]);
    const unbrokered = [...new Set([...brokered.unbrokered, ...vouched])];
    return { command: this.options.bwrap, args: [...bwrapArgs(plan), "--", inner.command, ...inner.args], env: brokered.env, plan, token: brokered.token, release: brokered.release, unbrokered, extraFds };
  }

  /** Keys become a per-process token when the broker is on and the box has its own network (the bridge to the broker). */
  private broker(env: Record<string, string>, plan: BoxPlan, request: BoxRequest): { env: Record<string, string>; token: string | null; release(): void; unbrokered: string[] } {
    const broker = this.options.broker;
    if (!broker || plan.net !== "isolated") return { env, token: null, release: () => {}, unbrokered: [] };
    const ids = request.cwd ? taskWorkspaceIds(request.cwd, this.options.setup.dataDir) : null;
    // The token is minted first (its value goes in the environment), then granted exactly what the rewrite took out.
    const minted = broker.mintForProcess({ botId: plan.botId, threadId: ids?.threadId ?? null, grants: {} });
    const rewrite = brokerRewrite(env, minted.token, broker.port);
    broker.revoke(minted.token);
    if (!Object.keys(rewrite.grants).length) return { env, token: null, release: () => {}, unbrokered: rewrite.unbrokered };
    const granted = broker.mintForProcess({ botId: plan.botId, threadId: ids?.threadId ?? null, grants: rewrite.grants });
    const again = brokerRewrite(env, granted.token, broker.port);
    return { env: again.env, token: granted.token, release: () => broker.revoke(granted.token), unbrokered: again.unbrokered };
  }
}

export interface BoxChecks { passed: number; total: number; failed: string[]; at: number }

export interface BoxReport {
  box: BoxKind;
  reason: BoxDetection["reason"];
  /** The last self-check (box-probe.ts inside a real box): `passed/total`, null before it ran. */
  checks: BoxChecks | null;
  bridge: "socat" | "node" | null;
  /** Spawns boxed since boot, and what the gates refused. */
  boxed: number;
  refused: { egress: number; harness: number };
  /** The credential broker: on with the box; live tokens, calls forwarded and refused, and key names left raw. */
  broker: { on: boolean; tokens: number; forwarded: number; refused: number; unbrokered: string[] };
  /** The extra layers (T0c): the seccomp filter in every box, the host's /proc with hidepid, Fly's API socket root-only. */
  hardening: { seccomp: "on" | "off" | "unsupported"; denied: number; hidepid: boolean; flyApiPrivate: boolean };
}

/** The filter file, written once at start (0600) and handed to each box on a read-only descriptor. */
export function writeSeccompFile(dir: string): string | null {
  if (!seccompSupported()) return null;
  const file = join(dir, "seccomp.bpf");
  writeFileSync(file, seccompBytes(), { mode: 0o600 });
  return file;
}

/** Whether the host's /proc hides other users' processes (the Cloud supervisor remounts it so at boot). */
export function procHidepid(mounts: () => string = () => readFileSync("/proc/mounts", "utf8")): boolean {
  try { return /^proc \/proc proc [^\n]*\bhidepid=(?:2|invisible)\b/m.test(mounts()); } catch { return false; }
}

/** Whether Fly's local API socket folder is root's alone (no bits for group or others). */
export function flyApiPrivate(stat: (path: string) => { mode: number } = statSync): boolean {
  try { return (stat("/.fly").mode & 0o077) === 0; } catch { return true; }
}

export interface StartOptions {
  dataDir: string;
  home: string;
  /** The server's loopback port: the harness gate forwards /api/internal/ there. */
  port: number;
  env?: Record<string, string | undefined>;
  denyEnv: ReadonlySet<string>;
  codeRoots?: readonly string[];
  engineRoots?: readonly string[];
  log?: (line: string) => void;
  /** Overrides for tests. */
  detect?: (env: Record<string, string | undefined>) => BoxDetection;
}

export function defaultCodeRoots(): string[] {
  const roots = [dirname(SERVER_ROOT)];
  const node = dirname(dirname(process.execPath));
  if (!roots.some((root) => node.startsWith(root))) roots.push(node);
  return roots;
}

export class BotBox {
  private detection: BoxDetection = { box: "off", reason: "not-cloud", tools: null };
  private runner: BoxRunner | null = null;
  private egress: BoxEgressGate | null = null;
  private harness: HarnessGate | null = null;
  private credentials: CredentialBroker | null = null;
  private seccompFile: string | null = null;
  private checks: BoxChecks | null = null;
  private boxed = 0;
  private unbrokered = new Set<string>();
  private started: StartOptions | null = null;

  /** Detects, and when the box is on opens the gates. Safe to call once; returns what it decided. */
  async start(options: StartOptions): Promise<BoxDetection> {
    this.started = options;
    const env = options.env ?? process.env;
    this.detection = (options.detect ?? ((e) => detectBox({ env: e })))(env);
    const log = options.log ?? ((line: string) => console.log(line));
    if (this.detection.box !== "bwrap" || !this.detection.tools) {
      log(`bot box: off (${this.detection.reason})`);
      return this.detection;
    }
    const dir = join(options.dataDir, "box");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const egressSocket = join(dir, "egress.sock"), harnessSocket = join(dir, "harness.sock"), brokerSocket = join(dir, "broker.sock");
    for (const socket of [egressSocket, harnessSocket, brokerSocket]) rmSync(socket, { force: true });
    this.egress = await openBoxEgressGate({ socketPath: egressSocket });
    this.harness = await openHarnessGate({ socketPath: harnessSocket, port: options.port });
    this.credentials = await openCredentialBroker({ socketPath: brokerSocket });
    this.seccompFile = writeSeccompFile(dir);
    const bridges: BoxBridge[] = [
      { name: "egress", port: BOX_EGRESS_PORT, socket: egressSocket },
      { name: "harness", port: options.port, socket: harnessSocket },
      { name: "broker", port: BOX_BROKER_PORT, socket: brokerSocket },
    ];
    this.runner = new BoxRunner({
      bwrap: this.detection.tools.bwrap,
      bridge: { socat: this.detection.tools.socat, bridgeScript: BOX_BRIDGE_SCRIPT, node: process.execPath },
      setup: { dataDir: options.dataDir, home: options.home, codeRoots: options.codeRoots ?? defaultCodeRoots(), engineRoots: options.engineRoots ?? engineInstallRoots(options.dataDir), bridges },
      denyEnv: options.denyEnv, seccompFile: this.seccompFile,
      broker: { port: BOX_BROKER_PORT, mintForProcess: this.credentials.mintForProcess, revoke: this.credentials.revoke },
    });
    log(`bot box: on (bubblewrap, ${this.detection.tools.socat ? "socat" : "node"} bridges, credential broker, seccomp ${this.seccompFile ? "on" : "unsupported here"})`);
    return this.detection;
  }

  /** The broker for callers that mint conversation-bound grants, or null when the box (and so the broker) is off. */
  broker(): BoxBroker | null {
    const credentials = this.credentials;
    return credentials ? { port: BOX_BROKER_PORT, mintForThread: credentials.mintForThread, touchThread: credentials.touchThread, revokeThread: credentials.revokeThread, lookup: credentials.lookup } : null;
  }

  /** The broker's socket, for a self-check that bridges it. */
  brokerSocket(): string | null { return this.credentials?.socketPath ?? null; }

  /** The filter file each box gets, for a self-check. */
  seccomp(): string | null { return this.seccompFile; }

  /** The box for one spawn, or null when turns are not boxed here. */
  wrap(request: BoxRequest): WrappedSpawn | null {
    if (!this.runner) return null;
    const wrapped = this.runner.wrap(request);
    this.boxed += 1;
    for (const name of wrapped.unbrokered) this.unbrokered.add(name);
    return wrapped;
  }

  enabled(): boolean { return this.runner !== null; }

  /** The box a bot's Chrome runs in: the system read-only, private /tmp and /run, the host's network (the browser's own
   * gate filters it), `ro` paths, and nothing of HOME or the data folder; the launcher binds the one profile it starts
   * Chrome on. bubblewrap's options before `--`; null when turns are not boxed here. */
  browserBox(seccompFd: number, ro: readonly string[]): { bwrap: string; options: string[]; seccomp: string | null } | null {
    if (!this.runner || !this.detection.tools) return null;
    const setup = { ...this.runner.setup, engineRoots: [] };
    const seccomp = this.seccompFile && !setup.mutate?.has("no-seccomp") ? this.seccompFile : null;
    const plan = planBox({ ...setup, seccompFd: seccomp ? seccompFd : undefined }, { command: "chrome", args: [], env: {}, net: "shared", ro });
    const home = resolve(setup.home), dataDir = resolve(setup.dataDir);
    const mounts = plan.mounts.filter((mount) => !(mount.kind === "bind" && mount.target === home) && !(mount.kind === "tmpfs" && mount.target === dataDir));
    return { bwrap: this.detection.tools.bwrap, options: bwrapArgs({ ...plan, mounts }), seccomp };
  }

  /** More read-write folders for one conversation's boxes (a memory layer); nothing without a runner. */
  lend(botId: string, threadId: string, rw: readonly string[]): void { this.runner?.lend(botId, threadId, rw); }

  tools(): { bwrap: string; socat: string | null } | null { return this.detection.tools; }

  noteChecks(checks: BoxChecks): void { this.checks = checks; }

  report(): BoxReport {
    return {
      box: this.detection.box,
      reason: this.detection.reason,
      checks: this.checks,
      bridge: this.detection.tools ? (this.detection.tools.socat ? "socat" : "node") : null,
      boxed: this.boxed,
      refused: { egress: this.egress?.refused ?? 0, harness: this.harness?.refused ?? 0 },
      broker: { on: this.credentials !== null, ...(this.credentials?.stats() ?? { tokens: 0, forwarded: 0, refused: 0 }), unbrokered: [...this.unbrokered].sort() },
      hardening: {
        seccomp: this.runner ? (this.seccompFile ? "on" : "unsupported") : "off", denied: this.seccompFile ? DENIED_SYSCALLS.length : 0,
        hidepid: process.platform === "linux" && procHidepid(), flyApiPrivate: process.platform === "linux" && existsSync("/.fly") ? flyApiPrivate() : true,
      },
    };
  }

  startOptions(): StartOptions | null { return this.started; }

  async stop(): Promise<void> {
    await Promise.all([this.egress?.close(), this.harness?.close(), this.credentials?.close()]);
    this.egress = null;
    this.harness = null;
    this.credentials = null;
    this.seccompFile = null;
    this.runner = null;
  }
}

export const botBox = new BotBox();
