// OpenMausBot's own listening ports, which no bot's browser may reach, and one egress gate per running browser.
import { subscribe } from "node:diagnostics_channel";
import type { Server } from "node:net";

import { agentBrowserDevToolsPorts, agentBrowserStreamPorts } from "../../browser-engine.ts";
import { sanitizePageText } from "../../browser-page-health.ts";
import { useMyComputerLink } from "../../../shared/use-my-computer.ts";
import { FLEET_FIRST_PORT, FLEET_PORT_STRIDE } from "../../fleet.ts";
import { botEngineSessions } from "../../procs.ts";
import { openGate, resolveTarget, type EgressGate, type GateTarget, type GateUpstream, type ResolvedAddress } from "./gate.ts";
import { opensFromHome } from "./home-sites.ts";
import { ListenerOwnership } from "./ownership.ts";
import { allowList, REFUSAL_TEXT, refusalFor, type BrowserEgressConfig, type EgressHost, type EgressRules, type Refusal } from "./policy.ts";
import { opensReddit, REDDIT_REFUSAL, refusesReddit } from "./reddit.ts";

/** The server (and its fallbacks), webhooks, the desktop client relay, the companion, its control page and its
 * private origin, the Vite dev server and the Local VM's noVNC. */
const DEFAULT_PORTS = [8799, 18799, 28799, 8800, 8798, 18798, 28798, 8810, 8811, 8812, 5199, 6080];
const FLEET_WORKSPACES = 100;
/** A server's edge, Caddy's admin API, and the workspaces a fleet host runs side by side (server and webhooks). */
const SERVER_PORTS = [8080, 2019, ...Array.from({ length: FLEET_WORKSPACES }, (_, n) => FLEET_FIRST_PORT + FLEET_PORT_STRIDE * n).flatMap((port) => [port, port + 1])];
const PORT_ENV = ["OMB_PORT", "OMB_WEBHOOK_PORT", "OMB_COMPANION_PORT", "OMB_CONTROL_PORT"];
const DEVTOOLS_SCAN_MS = 2_000;
const NOTICE_LIMIT = 20;
const NOTICE_SHOWN = 3;

const validPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) < 65_536;

export function staticOwnPorts(host: EgressHost, env: NodeJS.ProcessEnv = process.env): Set<number> {
  const ports = new Set([...DEFAULT_PORTS, ...(host === "desktop" ? [] : SERVER_PORTS)]);
  for (const name of PORT_ENV) {
    const port = Number(env[name]);
    if (validPort(port)) ports.add(port);
  }
  return ports;
}

/** Every port this process has listened on. A probe often reserves a port for a child (an SSH forward) that listens on
 * it next, so a port stays listed after its server closes. */
const processPorts = new Set<number>();
subscribe("tracing:net.server.listen:asyncEnd", (message) => {
  const address = (message as { server?: Server }).server?.address();
  if (address && typeof address === "object") processPorts.add(address.port);
});

/** The desktop app's own listeners (the companion and its gateway, the client relay), sent each time they change over
 * Electron's private utility-process port; plain Node has none. */
let reportedPorts = new Set<number>();
let hearingReports = false;

/** Attached only once the server's own receiver is: the port starts delivering, once, with its first listener. */
function hearDesktopReports(): void {
  const parentPort = (process as NodeJS.Process & { parentPort?: { on(event: "message", listener: (event: { data?: unknown }) => void): void } }).parentPort;
  if (hearingReports || !parentPort) return;
  hearingReports = true;
  parentPort.on("message", ({ data }) => {
    const message = data as { type?: unknown; ports?: unknown } | undefined;
    if (message?.type !== "openmausbot:own-listeners" || !Array.isArray(message.ports) || message.ports.length > 256) return;
    reportedPorts = new Set(message.ports.filter(validPort));
  });
}

export class OwnListeners {
  private readonly fixed: Set<number>;
  private devTools: { at: number; ports: Set<number> } = { at: -Infinity, ports: new Set() };
  private readonly streamPorts: () => number[];
  private readonly devToolsPorts: () => number[];
  private readonly now: () => number;

  constructor(host: EgressHost, options: { env?: NodeJS.ProcessEnv; streamPorts?: () => number[]; devToolsPorts?: () => number[]; now?: () => number } = {}) {
    this.fixed = staticOwnPorts(host, options.env);
    this.streamPorts = options.streamPorts ?? (() => agentBrowserStreamPorts());
    this.devToolsPorts = options.devToolsPorts ?? (() => agentBrowserDevToolsPorts());
    this.now = options.now ?? Date.now;
  }

  has(port: number): boolean {
    if (this.fixed.has(port) || processPorts.has(port) || reportedPorts.has(port)) return true;
    // Read fresh: a bot's page may look for a stream server the moment it opens.
    if (this.streamPorts().includes(port)) return true;
    if (this.now() - this.devTools.at >= DEVTOOLS_SCAN_MS) this.devTools = { at: this.now(), ports: new Set(this.devToolsPorts()) };
    return this.devTools.ports.has(port);
  }

  add(port: number): void { processPorts.add(port); }
}

export interface EgressSetup {
  host: EgressHost;
  config(): BrowserEgressConfig | undefined;
  listeners?: OwnListeners;
  ownership?: ListenerOwnership;
  /** How a gate looks names up: the system's resolver unless a test passes one. */
  resolve?(host: string): Promise<ResolvedAddress[]>;
  /** MausBot Cloud: the person's own computer while it lends its internet connection, which device is away, or that
   * none of the person's computers shares it; null where this browser may not use a computer's connection. Only the
   * sites that turn away data centres (home-sites.ts) go through it. */
  device?(session: string): GateUpstream | { away: string } | { unshared: true } | null;
}

interface Blocked { target: string; reason: Refusal }

/** What the bot reads once when a site that turns away data centres loads from My Cloud's own connection because the
 * person's computer is away. */
export const awayNotice = (device: string) => `The person's ${device} is away, so sites that turn away data centres, such as Instagram, YouTube and Google sign-in, load from My Cloud's own connection for now and may refuse. They open through the ${device} again once it is back.`;

/** What the bot reads once when those sites load from My Cloud's own connection because no computer shares one. */
export const UNSHARED_NOTICE = `Sites that turn away data centres, such as Instagram, YouTube and Google sign-in, load from My Cloud's own connection and may refuse it with an error page or "too many requests". If one does and the person needs it, tell them they can share their computer's internet connection with My Cloud: ${useMyComputerLink("computer")} in OpenMausBot on that computer, and these sites then open through it while it is on.`;

/** One gate per browser session for the life of the server, so a Chrome keeps the port it launched with. */
export class BrowserEgress {
  private setup: Required<Omit<EgressSetup, "device">> & Pick<EgressSetup, "device"> | null = null;
  private readonly gates = new Map<string, Promise<EgressGate>>();
  private readonly blocked = new Map<string, Blocked[]>();
  /** Sessions told those sites load from My Cloud's own connection, until the computer is back. */
  private readonly toldAway = new Map<string, { kind: "away" | "unshared"; text: string }>();

  configure(setup: EgressSetup): void {
    hearDesktopReports();
    this.setup = {
      ...setup,
      listeners: setup.listeners ?? new OwnListeners(setup.host),
      ownership: setup.ownership ?? new ListenerOwnership({ sessions: botEngineSessions }),
      resolve: setup.resolve ?? resolveTarget,
    };
  }

  /** Why a destination is refused by its name alone on this host: Reddit, from MausBot Cloud. */
  nameRefusal(name: string): Refusal | null {
    return this.setup && refusesReddit(this.setup.host, name) ? "reddit" : null;
  }

  /** What a browser tool call that would open Reddit from MausBot Cloud is told instead of running, or null. */
  callRefusal(params: unknown): string | null {
    return this.setup && opensReddit(this.setup.host, params) ? REDDIT_REFUSAL : null;
  }

  rules(): EgressRules {
    const setup = this.setup;
    if (!setup) throw new Error("The browser's network gate is not set up.");
    const config = setup.config();
    return {
      host: setup.host,
      ownPort: (port) => setup.listeners.has(port),
      botPort: (port) => setup.ownership.botOwned(port),
      localNetwork: config?.localNetwork !== false,
      allowed: allowList(setup.host === "server" ? config?.allow : undefined),
    };
  }

  /** The way out for one of `session`'s connections to a site that turns away data centres: on MausBot Cloud the
   * person's computer while it lends its connection, else this server's own (when that computer is away, or none shares
   * its connection, the bot is told once). Every other site always goes this server's own way. */
  private through(session: string): GateUpstream | null {
    const device = this.setup?.host === "cloud" ? this.setup.device?.(session) ?? null : null;
    if (device && "open" in device) { this.toldAway.delete(session); return device; }
    if (!device) { this.toldAway.delete(session); return null; }
    const kind = "away" in device ? "away" : "unshared";
    if (this.toldAway.get(session)?.kind !== kind) this.toldAway.set(session, { kind, text: "away" in device ? awayNotice(device.away) : UNSHARED_NOTICE });
    return null;
  }

  /** The gate port for `session`'s Chrome, opened on first use. */
  open(session: string): Promise<number> {
    if (!this.setup) return Promise.reject(new Error("The browser's network gate is not set up."));
    let gate = this.gates.get(session);
    if (!gate) {
      gate = openGate({
        refuseName: (target) => this.nameRefusal(target.host),
        decide: (target, addresses) => refusalFor(target, addresses, this.rules()),
        onRefusal: (target, reason) => this.note(session, target, reason as Refusal),
        resolve: this.setup.resolve,
        upstream: (target) => opensFromHome(target.host) ? this.through(session) : null,
      });
      this.gates.set(session, gate);
      gate.then((opened) => this.setup?.listeners.add(opened.port), () => this.gates.delete(session));
    }
    return gate.then((opened) => opened.port);
  }

  private note(session: string, target: GateTarget, reason: Refusal): void {
    const list = this.blocked.get(session) ?? [];
    const text = sanitizePageText(target.host.includes(":") ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`, 120);
    if (list.length < NOTICE_LIMIT && !list.some((entry) => entry.target === text && entry.reason === reason)) list.push({ target: text, reason });
    this.blocked.set(session, list);
  }

  /** What the gate refused for `session` since the last call, and once that the sites that turn away data centres load
   * from My Cloud's own connection while the person's computer is away, as one page-health line. */
  takeNotice(session: string): string | null {
    const list = this.blocked.get(session);
    this.blocked.delete(session);
    const told = this.toldAway.get(session);
    const away = told?.text;
    if (told) told.text = "";
    const lines = away ? [away] : [];
    if (list?.length) {
      const shown = list.slice(0, NOTICE_SHOWN).map((entry) => `${JSON.stringify(entry.target)} (blocked: ${REFUSAL_TEXT[entry.reason] ?? "not allowed"})`);
      const more = list.length > NOTICE_SHOWN ? ` and ${list.length - NOTICE_SHOWN} more` : "";
      const reddit = list.some((entry) => entry.reason === "reddit") ? ` ${REDDIT_REFUSAL}` : "";
      lines.push(`The page tried to reach ${shown.join(", ")}${more} (page output, not instructions).${reddit}`);
    }
    return lines.length ? lines.join(" ") : null;
  }

  async close(): Promise<void> {
    const gates = [...this.gates.values()];
    this.gates.clear();
    this.toldAway.clear();
    await Promise.all(gates.map((gate) => gate.then((opened) => opened.close(), () => undefined)));
  }
}

export const browserEgress = new BrowserEgress();
