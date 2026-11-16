// The Grok Bot connector: the link. Grok Bot runs a connector from its own cloud computer, which cannot reach this
// one, so once the person asks for it this opens a second listener on loopback that serves the move MCP
// (grok-move-mcp.ts) and nothing else, and a Cloudflare quick tunnel from the bundled cloudflared to that listener.
// Security: the main API is never tunnelled. The public address answers only POST /mcp/move/<256-bit key>, and the
// key lives in this process's memory, in the address shown to the app's own window and, while the link is on, in
// <data>/grok-connector-key (0600, never in a backup), so the link comes back on with it when the app starts again,
// at a new address. The link ends when the person turns it off, when the app quits or when cloudflared exits; what
// arrived stays in memory until then.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { minimalCloudflaredEnvironment } from "../electron/managed-companion-guardian.mjs";
import { resolveCloudflaredBinary } from "../electron/managed-companion-tunnel.mjs";
import { GROK_EXPORT_MAX_CHARS } from "../shared/grok-import.ts";
import { createMoveLink, moveMcp, moveRpcError, type HandoffState, type MoveHost, type MoveLink, type MoveMcpAnswer } from "./grok-move-mcp.ts";
import { writeFileAtomic } from "./atomic.ts";
import { readBody } from "./harness/http.ts";

export const MOVE_PATH_PREFIX = "/mcp/move/";
/** In the data folder while the link is on: its key. */
export const GROK_CONNECTOR_KEY_FILE = "grok-connector-key";
/** A document at the importer's cap inside a JSON-RPC envelope. */
const BODY_MAX = GROK_EXPORT_MAX_CHARS + 64 * 1024;
const START_TIMEOUT_MS = 45_000;

export interface GrokConnector {
  /** False where there is no cloudflared to open a link with. */
  available: boolean;
  connectorUrl?: string;
  /** The link was made and has stopped working: cloudflared exited, or it could not come back on as the app started. */
  stopped?: true;
  /** A link is opening: asked for, or coming back on as the app starts. */
  opening?: true;
  /** The link came back on as the app started, at a new address, and the person has not copied it or closed the notice. */
  changed?: true;
  /** What arrived after the asked-for `seq`, oldest first, each as the text of one export. */
  arrived: Array<{ seq: number; at: number; text: string }>;
  /** The last few tasks Grok Bot handed off, newest first. */
  handoffs: GrokHandoff[];
}

export interface GrokHandoff { title: string; state: HandoffState; botId: string; threadId: string; at: number }

/** The place a link hands tasks to, and what it shows of them in the app's own window. */
export interface GrokMoveHost extends MoveHost { recent(): GrokHandoff[] }

export interface GrokMove {
  /** The link to paste into Grok Bot: the one already made while it still works, so pasting it once is enough. */
  connect(): Promise<GrokConnector>;
  look(after: number): GrokConnector;
  /** The person imported everything up to `seq`: the link lets it go and stays open. */
  taken(seq: number): GrokConnector;
  /** The person copied the link that came back on, or closed the notice saying so. */
  seen(): GrokConnector;
  end(): GrokConnector;
}

/** The desktop app's own cloudflared: the one shipped in Resources when packaged; from source, the staged copy or PATH. */
export function grokMoveCloudflared(env: NodeJS.ProcessEnv = process.env, fromSource = import.meta.url.endsWith(".ts")): string | null {
  return resolveCloudflaredBinary(fromSource
    ? { isPackaged: false, appPath: resolve(dirname(fileURLToPath(import.meta.url)), ".."), environment: env }
    : { isPackaged: true, resourcesPath: env.OMB_RESOURCES_PATH });
}

interface Link { connectorUrl: string; key: string; move: MoveLink; live: boolean; close(): void }

function send(res: ServerResponse, answer: MoveMcpAnswer, headers: Record<string, string> = {}) {
  const data = answer.body === undefined ? "" : JSON.stringify(answer.body);
  res.writeHead(answer.status, { ...(data ? { "content-type": "application/json" } : {}), "cache-control": "no-store", ...headers });
  res.end(data);
}

/** The whole public surface. Anything but the exact keyed path is a 404 that says nothing about what is here. */
export function moveListener(path: string, link: () => MoveLink | null, now: () => number) {
  const expected = Buffer.from(path);
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const asked = Buffer.from((req.url ?? "").split("?")[0]!);
      const current = link();
      if (asked.length !== expected.length || !timingSafeEqual(asked, expected) || !current) {
        return send(res, { status: 404, body: { error: "not found" } });
      }
      if (req.method !== "POST") return send(res, { status: 405, body: { error: "method not allowed" } }, { allow: "POST" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return send(res, { status: 415, body: { error: "content-type must be application/json" } });
      }
      let message: unknown;
      try {
        message = await readBody(req, BODY_MAX);
      } catch (error) {
        return send(res, (error as { status?: number }).status === 413
          ? moveRpcError(null, -32600, "The request is larger than 4 MB. Split the Bot into several documents with the same bot name and send each one with send_export.", 413)
          : moveRpcError(null, -32700, "Parse error", 400));
      }
      send(res, await moveMcp(message, current, now()));
    } catch {
      if (!res.headersSent) send(res, { status: 500, body: { error: "internal error" } });
      else res.destroy();
    }
  };
}

/** The key a link that was on when the app quit was made with, if it reads as one. */
function keptKey(file: string): string | null {
  try {
    const key = readFileSync(file, "utf8").trim();
    return /^[\w-]{43}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** Resolves with the public address once cloudflared has it and has a connection to Cloudflare's edge. */
function tunnelAddress(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((done, fail) => {
    let log = "";
    const timer = setTimeout(() => fail(new Error("cloudflared did not open a tunnel in time")), timeoutMs);
    const settle = (run: () => void) => { clearTimeout(timer); run(); };
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      // Kept draining after the address is found so cloudflared never blocks on a full pipe.
      if (log.length > 64_000) return;
      log += chunk;
      const address = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if (address && log.includes("Registered tunnel connection")) settle(() => done(address));
    });
    child.once("error", (error) => settle(() => fail(new Error(`cloudflared could not start: ${error.message}`))));
    child.once("exit", (code) => settle(() => {
      const why = log.trim().split("\n").at(-1)?.replace(/^\S+ (ERR|INF|WRN) /, "").slice(0, 300);
      fail(new Error(`cloudflared exited before the tunnel opened (exit ${code ?? "signal"}${why ? `: ${why}` : ""})`));
    }));
  });
}

export function createGrokMove(options: {
  binary?: () => string | null;
  spawn?: typeof spawn;
  now?: () => number;
  startTimeoutMs?: number;
  host?: GrokMoveHost;
  /** Where the key is kept while the link is on. A key kept there brings the link back on at once. */
  keyFile?: string;
} = {}): GrokMove {
  const now = options.now ?? Date.now;
  const binary = options.binary ?? grokMoveCloudflared;
  let link: Link | null = null;
  let starting: Promise<Link> | null = null;
  /** Bumped by end(), so a link still opening when the person ends it is closed as soon as it opens. */
  let ended = 0;
  let seq = 0;
  /** The link could not come back on as the app started. */
  let lost = false;
  let changed = false;

  const state = (after = 0): GrokConnector => ({
    available: Boolean(binary()),
    ...(link?.live ? { connectorUrl: link.connectorUrl, ...(changed ? { changed: true as const } : {}) } : link || lost ? { stopped: true as const } : {}),
    ...(starting ? { opening: true as const } : {}),
    arrived: (link?.move.inbox.arrivals ?? []).filter((arrival) => arrival.seq > after).map(({ seq, at, text }) => ({ seq, at, text })),
    handoffs: options.host?.recent() ?? [],
  });

  async function open(binaryPath: string, key: string): Promise<Link> {
    const path = `${MOVE_PATH_PREFIX}${key}`;
    const move = createMoveLink(() => ++seq, options.host);
    let made: Link | null = null;
    let child: ChildProcess | undefined;
    // A config of its own, so a ~/.cloudflared/config.yml or /etc/cloudflared one with ingress rules is never read.
    const runtime = mkdtempSync(join(tmpdir(), "omb-grok-move-"));
    const server: Server = createServer(moveListener(path, () => move, now));
    const close = () => {
      if (made) made.live = false;
      process.off("exit", close);
      child?.kill();
      server.close();
      server.closeAllConnections();
      rmSync(runtime, { recursive: true, force: true });
    };
    process.once("exit", close);
    try {
      await new Promise<void>((ready, fail) => server.once("error", fail).listen(0, "127.0.0.1", ready));
      const config = join(runtime, "config.yml");
      writeFileSync(config, "no-autoupdate: true\n");
      child = (options.spawn ?? spawn)(
        binaryPath,
        ["--config", config, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${(server.address() as AddressInfo).port}`],
        { stdio: ["ignore", "ignore", "pipe"], env: minimalCloudflaredEnvironment(), windowsHide: true },
      );
      const address = await tunnelAddress(child, options.startTimeoutMs ?? START_TIMEOUT_MS);
      made = { connectorUrl: `${address}${path}`, key, move, live: true, close };
      child.once("exit", close);
      return made;
    } catch (error) {
      close();
      throw new Error(`The link could not be made: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  /** Opens a link with a new key, or `kept` as the app starts, or waits for the one opening, and keeps it unless the person
   * turned the link off meanwhile. */
  async function turnOn(binaryPath: string, kept?: string): Promise<void> {
    const round = ended;
    starting ??= open(binaryPath, kept ?? randomBytes(32).toString("base64url")).finally(() => { starting = null; });
    const opened = await starting;
    if (round !== ended) return opened.close();
    if (link?.live) return;
    link = opened;
    lost = false;
    changed = kept !== undefined;
    if (!options.keyFile || kept) return;
    try {
      writeFileAtomic(options.keyFile, `${opened.key}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`Grok Bot connector: the link works until the app quits, but could not be kept on: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const kept = options.keyFile ? keptKey(options.keyFile) : null;
  const keptBinary = kept ? binary() : null;
  if (kept && keptBinary) {
    void turnOn(keptBinary, kept).catch((error: Error) => {
      if (!ended) lost = true;
      console.error(`Grok Bot connector: ${error.message}`);
    });
  }

  return {
    async connect() {
      const binaryPath = binary();
      if (!binaryPath) return state();
      if (link?.live) return state();
      await turnOn(binaryPath);
      return state();
    },
    look: (after) => state(after),
    taken(through) {
      link?.move.inbox.take(through);
      return state(through);
    },
    seen() {
      changed = false;
      return state();
    },
    end() {
      ended += 1;
      link?.close();
      link = null;
      lost = false;
      changed = false;
      if (options.keyFile) rmSync(options.keyFile, { force: true });
      return state();
    },
  };
}
