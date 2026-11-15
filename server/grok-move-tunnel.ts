// Moving from Grok Bot over a connector: the link. Grok Bot runs a connector from its own cloud computer, which cannot
// reach this one, so while the person asks for it this opens a second listener on loopback that serves the move MCP
// (grok-move-mcp.ts) and nothing else, and a Cloudflare quick tunnel from the bundled cloudflared to that listener.
// Security: the main API is never tunnelled. The public address answers only POST /mcp/move/<256-bit key>, and the
// key lives in this process's memory and in the address shown to the app's own window. The link ends when the person
// ends it, after an hour, when the app quits or when cloudflared exits; what arrived stays in memory until then.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { minimalCloudflaredEnvironment } from "../electron/managed-companion-guardian.mjs";
import { resolveCloudflaredBinary } from "../electron/managed-companion-tunnel.mjs";
import { GROK_EXPORT_MAX_CHARS } from "../shared/grok-import.ts";
import { createMoveInbox, moveMcp, moveRpcError, type MoveInbox, type MoveMcpAnswer } from "./grok-move-mcp.ts";
import { readBody } from "./harness/http.ts";

export const MOVE_TTL_MS = 60 * 60 * 1000;
export const MOVE_PATH_PREFIX = "/mcp/move/";
/** A document at the importer's cap inside a JSON-RPC envelope. */
const BODY_MAX = GROK_EXPORT_MAX_CHARS + 64 * 1024;
const START_TIMEOUT_MS = 45_000;

export interface GrokConnector {
  /** False where there is no cloudflared to open a link with. */
  available: boolean;
  connectorUrl?: string;
  expiresAt?: number;
  /** The link was made and has stopped working: its hour ran out, or cloudflared exited. */
  stopped?: true;
  /** What arrived after the asked-for `seq`, oldest first, each as the text of one export. */
  arrived: Array<{ seq: number; at: number; text: string }>;
}

export interface GrokMove {
  /** The link to paste into Grok Bot: the one already made while it still works, so pasting it once is enough. */
  connect(): Promise<GrokConnector>;
  look(after: number): GrokConnector;
  end(): GrokConnector;
}

/** The desktop app's own cloudflared: the one shipped in Resources when packaged; from source, the staged copy or PATH. */
export function grokMoveCloudflared(env: NodeJS.ProcessEnv = process.env, fromSource = import.meta.url.endsWith(".ts")): string | null {
  return resolveCloudflaredBinary(fromSource
    ? { isPackaged: false, appPath: resolve(dirname(fileURLToPath(import.meta.url)), ".."), environment: env }
    : { isPackaged: true, resourcesPath: env.OMB_RESOURCES_PATH });
}

interface Link { connectorUrl: string; expiresAt: number; inbox: MoveInbox; live: boolean; close(): void }

function send(res: ServerResponse, answer: MoveMcpAnswer, headers: Record<string, string> = {}) {
  const data = answer.body === undefined ? "" : JSON.stringify(answer.body);
  res.writeHead(answer.status, { ...(data ? { "content-type": "application/json" } : {}), "cache-control": "no-store", ...headers });
  res.end(data);
}

/** The whole public surface. Anything but the exact keyed path is a 404 that says nothing about what is here. */
export function moveListener(path: string, link: () => { inbox: MoveInbox; expiresAt: number } | null, now: () => number) {
  const expected = Buffer.from(path);
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const asked = Buffer.from((req.url ?? "").split("?")[0]!);
      const current = link();
      if (asked.length !== expected.length || !timingSafeEqual(asked, expected) || !current || current.expiresAt <= now()) {
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
      send(res, moveMcp(message, current, now()));
    } catch {
      if (!res.headersSent) send(res, { status: 500, body: { error: "internal error" } });
      else res.destroy();
    }
  };
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
  ttlMs?: number;
  startTimeoutMs?: number;
} = {}): GrokMove {
  const now = options.now ?? Date.now;
  const binary = options.binary ?? grokMoveCloudflared;
  let link: Link | null = null;
  let starting: Promise<Link> | null = null;
  /** Bumped by end(), so a link still opening when the person ends it is closed as soon as it opens. */
  let ended = 0;
  let seq = 0;

  const state = (after = 0): GrokConnector => ({
    available: Boolean(binary()),
    ...(link?.live ? { connectorUrl: link.connectorUrl, expiresAt: link.expiresAt } : {}),
    ...(link && !link.live ? { stopped: true as const } : {}),
    arrived: (link?.inbox.arrivals ?? []).filter((arrival) => arrival.seq > after).map(({ seq, at, text }) => ({ seq, at, text })),
  });

  async function open(binaryPath: string): Promise<Link> {
    const path = `${MOVE_PATH_PREFIX}${randomBytes(32).toString("base64url")}`;
    const expiresAt = now() + (options.ttlMs ?? MOVE_TTL_MS);
    const inbox = createMoveInbox(() => ++seq);
    let made: Link | null = null;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    // A config of its own, so a ~/.cloudflared/config.yml or /etc/cloudflared one with ingress rules is never read.
    const runtime = mkdtempSync(join(tmpdir(), "omb-grok-move-"));
    const server: Server = createServer(moveListener(path, () => ({ inbox, expiresAt }), now));
    const close = () => {
      if (made) made.live = false;
      clearTimeout(timer);
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
      made = { connectorUrl: `${address}${path}`, expiresAt, inbox, live: true, close };
      child.once("exit", close);
      timer = setTimeout(close, Math.max(0, expiresAt - now()));
      timer.unref();
      return made;
    } catch (error) {
      close();
      throw new Error(`The link could not be made: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  return {
    async connect() {
      const binaryPath = binary();
      if (!binaryPath) return state();
      if (link?.live) return state();
      const round = ended;
      starting ??= open(binaryPath).finally(() => { starting = null; });
      const opened = await starting;
      if (round !== ended) opened.close();
      else if (!link?.live) link = opened;
      return state();
    },
    look: (after) => state(after),
    end() {
      ended += 1;
      link?.close();
      link = null;
      return state();
    },
  };
}
