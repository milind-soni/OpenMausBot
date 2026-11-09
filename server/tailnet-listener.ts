// This server on the tailnet: either `tailscale serve` fronts it with HTTPS (nothing is bound here, the origin goes into
// links), or it listens on each tailnet address itself.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

import { IDLE_HTTP_SERVER } from "./due-timer.ts";
import { bareAddress, inTailscaleRange, isTailnetName, tailnetHosts, tailnetInterfaceAddresses, tailnetOrigin } from "../electron/tailnet.mjs";

/** `addresses: "interface"` follows whatever Tailscale's own interface carries. */
export type TailnetShareConfig = { name: string; served: string } | { name: string; addresses: string[] | "interface" };

export interface TailnetShareState {
  origin: string | null;
  listening: string[];
  error: string | null;
}

const FOLLOW_MS = 15_000;

const notShareable = (address: string) => /^(?:0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/.test(address) || address.startsWith("127.") || address === "::1";

/** A served origin must be `https://<name>[:port]` and nothing more. */
function servedOrigin(name: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const bare = url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    return bare && url.hostname === name ? url.origin : null;
  } catch {
    return null;
  }
}

/** Fails closed: anything malformed is no share at all. */
export function readTailnetShare(input: unknown): TailnetShareConfig | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!isTailnetName(name)) return null;
  if (raw.served !== undefined) {
    const served = servedOrigin(name, raw.served);
    return served ? { name, served } : null;
  }
  if (raw.addresses === undefined || raw.addresses === "interface") return { name, addresses: "interface" };
  if (!Array.isArray(raw.addresses) || raw.addresses.length === 0 || raw.addresses.length > 8) return null;
  const addresses = raw.addresses.map((address) => bareAddress(String(address)));
  return addresses.every((address) => isIP(address) !== 0 && !notShareable(address)) ? { name, addresses: [...new Set(addresses)] } : null;
}

/** `OMB_TAILNET_NAME` with `OMB_TAILNET_SERVED` (the HTTPS origin `tailscale serve` gives it) or `OMB_TAILNET_ADDRESSES`
 * (a comma list; unset follows Tailscale's interface). `openmausbot serve --tailscale` sets them. */
export function tailnetShareFromEnv(env: NodeJS.ProcessEnv): TailnetShareConfig | null {
  if (!env.OMB_TAILNET_NAME) return null;
  const addresses = env.OMB_TAILNET_ADDRESSES?.split(",").map((part) => part.trim()).filter(Boolean);
  return readTailnetShare({ name: env.OMB_TAILNET_NAME, ...(env.OMB_TAILNET_SERVED ? { served: env.OMB_TAILNET_SERVED } : {}), ...(addresses?.length ? { addresses } : {}) });
}

/**
 * Security: a peer is answered only when it is a Tailscale address or this machine itself (a connection to one of its own
 * addresses comes from that address). Tailscale delivers a peer's packets only with that peer's own source address.
 */
export function tailnetPeerAllowed(remoteAddress: string | undefined, bound: readonly string[]): boolean {
  const remote = bareAddress(remoteAddress);
  return Boolean(remote) && (inTailscaleRange(remote) || bound.includes(remote));
}

export function hostAllowed(host: string | string[] | undefined, allowed: ReadonlySet<string>): boolean {
  const value = (Array.isArray(host) ? host[0] : host)?.trim().toLowerCase();
  return Boolean(value) && allowed.has(value!);
}

type Handle = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;

export interface TailnetShareOptions {
  port: number;
  handle: Handle;
  /** WebSocket upgrades through the same handler. */
  attach: (server: Server, handle: Handle) => void;
  log?: (line: string) => void;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
}

export function createTailnetShare(options: TailnetShareOptions) {
  const log = options.log ?? (() => {});
  const interfaces = options.interfaces ?? networkInterfaces;
  let started = false;
  let desired: TailnetShareConfig | null = null;
  let listeners = new Map<string, Server>();
  let allowed: ReadonlySet<string> = new Set();
  let error: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let applying = Promise.resolve();
  let tellParent: ((answer: object) => void) | null = null;
  let toldParent = "";

  /** The desktop app hears what changed by itself: the share comes up after its message, or Tailscale's interface moves. */
  function announce(): void {
    const answer = JSON.stringify(share.state());
    if (!tellParent || answer === toldParent) return;
    toldParent = answer;
    tellParent({ type: "openmausbot:tailnet-share-state", ...share.state() });
  }

  const guarded: Handle = async (req, res) => {
    if (!hostAllowed(req.headers.host, allowed)) {
      res.writeHead(421, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "misdirected: this listener answers only this computer's tailnet name" }));
      return;
    }
    return options.handle(req, res);
  };

  const close = (server: Server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

  function open(address: string): Promise<Server> {
    const server = createServer(IDLE_HTTP_SERVER, guarded);
    options.attach(server, guarded);
    server.on("connection", (socket) => {
      if (!tailnetPeerAllowed(socket.remoteAddress, [...listeners.keys()])) socket.destroy();
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: options.port, host: address, ipv6Only: address.includes(":") }, () => {
        server.off("error", reject);
        server.on("error", (failure) => log(`tailnet: ${address} ${failure.message}`));
        resolve(server);
      });
    });
  }

  async function bind(config: TailnetShareConfig | null): Promise<void> {
    const wanted = config && "addresses" in config ? (config.addresses === "interface" ? tailnetInterfaceAddresses(interfaces()) : config.addresses) : [];
    for (const [address, server] of listeners) {
      if (!wanted.includes(address)) {
        listeners.delete(address);
        await close(server);
      }
    }
    const failures: string[] = [];
    for (const address of wanted) {
      if (listeners.has(address)) continue;
      try {
        listeners.set(address, await open(address));
        log(`tailnet: listening on ${address.includes(":") ? `[${address}]` : address}:${options.port} for ${config!.name}`);
      } catch (failure) {
        failures.push(`${address}: ${(failure as NodeJS.ErrnoException).code ?? (failure as Error).message}`);
      }
    }
    allowed = config ? tailnetHosts({ name: config.name, addresses: [...listeners.keys()], port: options.port }) : new Set();
    error = config && "addresses" in config && listeners.size === 0
      ? failures.length ? `could not listen on the tailnet (${failures.join("; ")})` : "Tailscale's interface has no address on this computer"
      : failures.length ? `could not listen on ${failures.join("; ")}` : null;
    if (error) log(`tailnet: ${error}`);
  }

  function follow(config: TailnetShareConfig | null) {
    if (timer) clearInterval(timer);
    timer = null;
    if (!config || !("addresses" in config) || config.addresses !== "interface") return;
    timer = setInterval(() => void reconcile().then(announce), FOLLOW_MS);
    timer.unref?.();
  }

  const reconcile = () => {
    applying = applying.then(() => (started ? bind(desired) : undefined)).catch((failure: Error) => log(`tailnet: ${failure.message}`));
    return applying;
  };

  const share = {
    /** Takes effect once the main listener is up; until then it is remembered. */
    apply(config: TailnetShareConfig | null): Promise<void> {
      desired = config;
      follow(config);
      return reconcile();
    },
    start(env: NodeJS.ProcessEnv = {}): Promise<void> {
      started = true;
      const fromEnv = desired ?? tailnetShareFromEnv(env);
      return (fromEnv ? share.apply(fromEnv) : reconcile()).then(announce);
    },
    /** The origin a pairing link uses: the served HTTPS one, or this listener's while it listens somewhere. */
    origin(): string | null {
      if (!desired) return null;
      if ("served" in desired) return desired.served;
      return listeners.size ? tailnetOrigin(desired.name, options.port) : null;
    },
    state(): TailnetShareState {
      return { origin: share.origin(), listening: [...listeners.keys()], error: desired && "served" in desired ? null : error };
    },
    /** The desktop app's private message; anything else is not ours. Replies with the state once it is applied. */
    receive(message: unknown, reply: (answer: object) => void): boolean {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "openmausbot:tailnet-share") return false;
      tellParent = reply;
      const config = readTailnetShare((message as { share?: unknown }).share);
      void share.apply(config).then(() => {
        toldParent = JSON.stringify(share.state());
        reply({ type: "openmausbot:tailnet-share-state", ...share.state() });
      });
      return true;
    },
    async close(): Promise<void> {
      started = false;
      follow(null);
      await applying;
      const open = [...listeners.values()];
      listeners = new Map();
      allowed = new Set();
      await Promise.all(open.map(close));
    },
  };
  return share;
}
