import type { KeyObject } from "node:crypto";
import { parseTokenKeys } from "./token.ts";

const MiB = 1024 * 1024;

/** Timers and limits from wire spec §3.9 and §3.10. Only tests change them, through startRelay. */
export interface Limits {
  /** Before auth: the one text message must arrive within this and fit in authMessageBytes. */
  authDeadlineMs: number;
  authMessageBytes: number;
  /** WebSocket maxPayload on every socket, before and after auth. */
  maxPayloadBytes: number;
  /** A host must send its admission set this soon after `hello`. */
  admitDeadlineMs: number;
  admissionMax: number;
  /** A host must open the data socket for a phone this soon after `open`; it is also a `sid`'s whole life. */
  openDeadlineMs: number;
  /** Control-socket messages after auth: a burst, then a steady rate. */
  controlBurst: number;
  controlPerSecond: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  ipNewPerMinute: number;
  ipOpenMax: number;
  hostSessionsMax: number;
  socketsMax: number;
  fullRetryMs: number;
  /** Backpressure: pause the source above highWater bytes queued for the destination, resume below lowWater. */
  highWaterBytes: number;
  lowWaterBytes: number;
  /** A paused source whose destination makes no progress this long closes the session. */
  wedgeMs: number;
  /** A session averaging above heavyBitsPerSecond over heavyWindowMs is held to throttleBitsPerSecond from then on. */
  heavyWindowMs: number;
  heavyBitsPerSecond: number;
  throttleBitsPerSecond: number;
  hostBytesPerDay: number;
  /** SIGTERM: what hosts are told in `restarting`, what phones are told in 4503, and when the process must be gone. */
  restartReconnectInMs: number;
  restartTryForMs: number;
  restartPhoneRetryMs: number;
  shutdownMs: number;
  /** A socket the relay closes and whose peer does not finish the close handshake is cut after this. */
  closeGraceMs: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  authDeadlineMs: 5_000,
  authMessageBytes: 4 * 1024,
  maxPayloadBytes: 70_000,
  admitDeadlineMs: 5_000,
  admissionMax: 32,
  openDeadlineMs: 10_000,
  controlBurst: 20,
  controlPerSecond: 2,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 10_000,
  ipNewPerMinute: 60,
  ipOpenMax: 256,
  hostSessionsMax: 16,
  socketsMax: 30_000,
  fullRetryMs: 5_000,
  highWaterBytes: 1 * MiB,
  lowWaterBytes: 256 * 1024,
  wedgeMs: 60_000,
  heavyWindowMs: 30 * 60_000,
  heavyBitsPerSecond: 50e6,
  throttleBitsPerSecond: 20e6,
  hostBytesPerDay: 50e9,
  restartReconnectInMs: 0,
  restartTryForMs: 15_000,
  restartPhoneRetryMs: 1_000,
  shutdownMs: 5_000,
  closeGraceMs: 2_000,
});

export interface RelayConfig {
  node: string;
  host: string;
  port: number;
  tokenKeys: ReadonlyMap<string, KeyObject>;
  /** /metrics answers only with this bearer; without one /metrics is off. */
  metricsToken: string | undefined;
  limits: Limits;
}

const NODE = /^relay[1-9][0-9]?$/;
const MIN_METRICS_TOKEN = 32;

/** Reads the deployment facts from the environment. Throws a message that never repeats a value it read. */
export function loadConfig(env: NodeJS.ProcessEnv): RelayConfig {
  const node = env.RELAY_NODE ?? "";
  if (!NODE.test(node)) throw new Error("RELAY_NODE must be relay1 … relay99");
  if (!env.RELAY_TOKEN_KEYS) throw new Error("RELAY_TOKEN_KEYS is required");
  const tokenKeys = parseTokenKeys(env.RELAY_TOKEN_KEYS);
  const metricsToken = env.RELAY_METRICS_TOKEN || undefined;
  if (metricsToken !== undefined && metricsToken.length < MIN_METRICS_TOKEN) {
    throw new Error(`RELAY_METRICS_TOKEN must be at least ${MIN_METRICS_TOKEN} characters`);
  }
  const port = Number(env.RELAY_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("RELAY_PORT must be a port number");
  return { node, host: env.RELAY_HOST ?? "127.0.0.1", port, tokenKeys, metricsToken, limits: { ...DEFAULT_LIMITS } };
}
