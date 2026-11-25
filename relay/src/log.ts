import { sha256 } from "./wire.ts";

/**
 * Every line the relay writes. Each field is a count, a duration, a close code or `hid8`, so no IP address, token,
 * admission value or payload byte has a field it could be written into.
 */
export type LogEvent =
  | { ev: "start"; port: number }
  | { ev: "session"; hid8: string; dur_s: number; up: number; down: number; close: number }
  | { ev: "host"; hid8: string; dur_s: number; close: number }
  | { ev: "throttle"; hid8: string }
  | { ev: "budget"; hid8: string }
  | { ev: "drain"; hosts: number; sessions: number }
  | { ev: "stop" };

export type Logger = (event: LogEvent) => void;

/** The first 8 hex characters of SHA256(hostId): enough to follow one host through the logs, not enough to dial it. */
export const hid8 = (hostId: Buffer): string => sha256(hostId).toString("hex").slice(0, 8);

export function jsonLogger(node: string, write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  return (event) => write(`${JSON.stringify({ ts: new Date().toISOString(), node, ...event })}\n`);
}
