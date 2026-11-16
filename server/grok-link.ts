// The Grok Bot connector: the link. Grok Bot runs a connector from its own cloud computer, which cannot reach this
// one, so the address it calls is on the connected-apps service (cloudflare/composio-broker), and this app holds one
// outbound socket to that service and answers each tool call the service relays.
// Security: nothing listens here and the main API is never exposed; the socket carries only the move MCP
// (grok-move-mcp.ts). The link's secret lives in this process and in <data>/grok-connector-key (0600, never in a
// backup) and leaves only as the header that attaches the socket. The address holds a one-way hash of it, so whoever
// has the address can call the four tools and can never attach in this app's place.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { WebSocket } from "ws";

import { managedComposioBrokerOff, normalizeManagedComposioBrokerUrl } from "../electron/managed-composio.mjs";
import {
  GROK_LINK_ANSWER_MAX,
  GROK_LINK_ATTACH_PATH,
  GROK_LINK_BODY_MAX,
  GROK_LINK_IN_FLIGHT,
  GROK_LINK_PATH_PREFIX,
  GROK_LINK_PING,
  GROK_LINK_PONG,
  GROK_LINK_REPLACED,
  GROK_LINK_SECRET_HEADER,
  isLinkSecret,
  linkKey,
  toDesktopSchema,
  type FromDesktop,
  type LinkSecret,
} from "../shared/grok-link.ts";
import { writeFileAtomic } from "./atomic.ts";
import { createMoveLink, moveBusy, moveManifest, moveMcp, moveRpcError, type HandoffState, type MoveHost, type MoveLink, type MoveMcpAnswer } from "./grok-move-mcp.ts";

/** In the data folder while the link is on: its secret. */
export const GROK_CONNECTOR_KEY_FILE = "grok-connector-key";
const CONNECT_WAIT_MS = 10_000;
const PING_MS = 30_000;
const PONG_MS = 10_000;
const RETRY_MAX_MS = 60_000;
const TURN_OFF_TIMEOUT_MS = 8_000;

/** `elsewhere`: another copy of the app attached with the same secret, so this one stays away until asked again. */
export type GrokReach = "connecting" | "connected" | "elsewhere";

export interface GrokConnector {
  /** False where there is no connected-apps service to hold the link's address. */
  available: boolean;
  /** Present while the connector is on. The address is the same for as long as it stays on. */
  link?: { url: string; reach: GrokReach };
  /** What arrived after the asked-for `seq`, oldest first, each as the text of one export. */
  arrived: Array<{ seq: number; at: number; text: string }>;
  /** The last few tasks Grok Bot handed off, newest first. */
  handoffs: GrokHandoff[];
}

export interface GrokHandoff { title: string; state: HandoffState; botId: string; threadId: string; at: number }

/** The place a link hands tasks to, and what it shows of them in the app's own window. */
export interface GrokMoveHost extends MoveHost { recent(): GrokHandoff[] }

export interface GrokMove {
  /** Turns the connector on if it is off, and answers once the service is reached or after a few seconds of trying. */
  connect(): Promise<GrokConnector>;
  look(after: number): GrokConnector;
  /** The person imported everything up to `seq`: the link lets it go and stays on. */
  taken(seq: number): GrokConnector;
  /** Turns the connector off. Turning it on again makes a new address. */
  end(): Promise<GrokConnector>;
}

export interface LinkSocket { send(text: string): void; close(): void }
export interface LinkSocketEvents { open(): void; text(text: string): void; closed(code: number): void }
export type LinkDial = (url: string, headers: Record<string, string>, events: LinkSocketEvents) => LinkSocket;

const dialWs: LinkDial = (url, headers, events) => {
  const ws = new WebSocket(url, { headers, handshakeTimeout: 15_000, maxPayload: GROK_LINK_BODY_MAX + 4_096 });
  ws.on("open", events.open);
  ws.on("message", (data, binary) => { if (!binary) events.text(data.toString()); });
  // ws 8 emits "close" after every "error", a refused handshake among them.
  ws.on("error", () => {});
  ws.on("close", (code) => events.closed(code));
  return { send: (text) => { if (ws.readyState === WebSocket.OPEN) ws.send(text); }, close: () => ws.terminate() };
};

/** The connected-apps service the desktop app named for this server, "" for none. */
export function grokLinkBrokerUrl(env: NodeJS.ProcessEnv = process.env): string {
  return managedComposioBrokerOff(env) ? "" : normalizeManagedComposioBrokerUrl(env.OMB_COMPOSIO_BROKER_URL);
}

function keptSecret(file: string): LinkSecret | null {
  try {
    const secret = readFileSync(file, "utf8").trim();
    return isLinkSecret(secret) ? secret : null;
  } catch {
    return null;
  }
}

const rpcId = (message: unknown): string | number | null => {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
};

interface On {
  secret: LinkSecret;
  base: string;
  url: string;
  reach: GrokReach;
  move: MoveLink;
  /** The socket now open or opening; a socket that is not this one is ignored. */
  socket: LinkSocket | null;
  attempt: number;
  inFlight: number;
  retry?: ReturnType<typeof setTimeout>;
  ping?: ReturnType<typeof setInterval>;
  pong?: ReturnType<typeof setTimeout>;
  /** connect() calls waiting to hear that the service was reached. */
  waiting: Array<() => void>;
}

export function createGrokMove(options: {
  now?: () => number;
  host?: GrokMoveHost;
  /** Where the secret is kept while the link is on. A secret kept there brings the link back on at once, at the same address. */
  keyFile?: string;
  brokerUrl?: () => string;
  dial?: LinkDial;
  fetch?: typeof fetch;
} = {}): GrokMove {
  const now = options.now ?? Date.now;
  const brokerUrl = options.brokerUrl ?? grokLinkBrokerUrl;
  const dial = options.dial ?? dialWs;
  let on: On | null = null;
  let seq = 0;
  /** connect() and end() take turns, so a link is never turned on and off at once. */
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = turn.then(run);
    turn = next.catch(() => {});
    return next;
  };

  const state = (after = 0): GrokConnector => ({
    available: brokerUrl() !== "",
    ...(on ? { link: { url: on.url, reach: on.reach } } : {}),
    arrived: (on?.move.inbox.arrivals ?? []).filter((arrival) => arrival.seq > after).map(({ seq, at, text }) => ({ seq, at, text })),
    handoffs: options.host?.recent() ?? [],
  });

  const heard = (link: On) => { for (const done of link.waiting.splice(0)) done(); };
  const quiet = (link: On) => {
    clearTimeout(link.retry);
    clearInterval(link.ping);
    clearTimeout(link.pong);
  };

  function take(link: On, socket: LinkSocket, text: string) {
    const parsed = toDesktopSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return;
    const { id, message } = parsed.data;
    const say = (frame: FromDesktop) => socket.send(JSON.stringify(frame));
    const answer = (reply: MoveMcpAnswer) => {
      const frame = JSON.stringify({ t: "answer", id, ...reply } satisfies FromDesktop);
      socket.send(frame.length <= GROK_LINK_ANSWER_MAX ? frame
        : JSON.stringify({ t: "answer", id, ...moveRpcError(rpcId(message), -32603, "The answer was too large to send.") } satisfies FromDesktop));
    };
    say({ t: "got", id });
    if (link.inFlight >= GROK_LINK_IN_FLIGHT) return answer(moveBusy(rpcId(message)));
    link.inFlight += 1;
    // Never awaited here: a task_status that holds for 25 seconds must not keep the next call waiting.
    void moveMcp(message, link.move, now())
      .catch(() => moveRpcError(rpcId(message), -32603, "Internal error"))
      .then((reply) => {
        link.inFlight -= 1;
        answer(reply);
      });
  }

  function open(link: On) {
    quiet(link);
    link.reach = "connecting";
    const current = () => on === link && link.socket === socket;
    const closed = (code: number) => {
      if (!current()) return;
      quiet(link);
      link.socket = null;
      if (code === GROK_LINK_REPLACED) {
        link.reach = "elsewhere";
        return heard(link);
      }
      link.reach = "connecting";
      const wait = Math.min(RETRY_MAX_MS, 1_000 * 2 ** link.attempt) * (0.5 + Math.random() / 2);
      link.attempt += 1;
      link.retry = setTimeout(() => open(link), wait);
      link.retry.unref();
    };
    const socket: LinkSocket = dial(`${link.base.replace(/^http/, "ws")}${GROK_LINK_ATTACH_PATH}`, { [GROK_LINK_SECRET_HEADER]: link.secret }, {
      open() {
        if (!current()) return;
        socket.send(JSON.stringify({ t: "hello", manifest: moveManifest() } satisfies FromDesktop));
        link.reach = "connected";
        link.attempt = 0;
        link.ping = setInterval(() => {
          socket.send(GROK_LINK_PING);
          clearTimeout(link.pong);
          // A socket through a sleeping computer or a dropped network stays "open": no pong means it is dead.
          link.pong = setTimeout(() => {
            socket.close();
            closed(0);
          }, PONG_MS);
          link.pong.unref();
        }, PING_MS);
        link.ping.unref();
        heard(link);
      },
      text(text) {
        if (!current()) return;
        if (text === GROK_LINK_PONG) return clearTimeout(link.pong);
        try {
          take(link, socket, text);
        } catch {
          // A frame that is not JSON asks for nothing.
        }
      },
      closed,
    });
    link.socket = socket;
  }

  async function turnOn(secret: LinkSecret, base: string): Promise<On> {
    const link: On = {
      secret, base, url: `${base}${GROK_LINK_PATH_PREFIX}${await linkKey(secret)}`, reach: "connecting",
      move: createMoveLink(() => ++seq, options.host), socket: null, attempt: 0, inFlight: 0, waiting: [],
    };
    on = link;
    open(link);
    return link;
  }

  const kept = options.keyFile ? keptSecret(options.keyFile) : null;
  if (kept && brokerUrl()) void inTurn(() => turnOn(kept, brokerUrl()));

  return {
    async connect() {
      const base = brokerUrl();
      if (!base) return state();
      const link = await inTurn(async () => {
        if (on) {
          if (on.reach === "elsewhere") open(on);
          return on;
        }
        const secret = randomBytes(32).toString("base64url") as LinkSecret;
        if (options.keyFile) writeFileAtomic(options.keyFile, `${secret}\n`, { mode: 0o600 });
        return turnOn(secret, base);
      });
      if (link.reach === "connecting") {
        await new Promise<void>((done) => {
          const timer = setTimeout(done, CONNECT_WAIT_MS);
          link.waiting.push(() => {
            clearTimeout(timer);
            done();
          });
        });
      }
      return state();
    },
    look: (after) => state(after),
    taken(through) {
      on?.move.inbox.take(through);
      return state(through);
    },
    async end() {
      await inTurn(async () => {
        const link = on;
        on = null;
        if (options.keyFile) rmSync(options.keyFile, { force: true });
        if (!link) return;
        quiet(link);
        link.socket?.close();
        heard(link);
        // The secret is gone, so nothing can attach to the old address again even when this never arrives.
        await (options.fetch ?? fetch)(`${link.base}${GROK_LINK_ATTACH_PATH}`, {
          method: "DELETE", headers: { [GROK_LINK_SECRET_HEADER]: link.secret }, signal: AbortSignal.timeout(TURN_OFF_TIMEOUT_MS),
        }).catch((error: Error) => console.error(`Grok Bot connector: the service was not told the link is off: ${error.message}`));
      });
      return state();
    },
  };
}
