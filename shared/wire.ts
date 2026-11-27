import type { ServerFrame } from "../packages/phone-protocol/src/wire.ts";

export * from "../packages/phone-protocol/src/effort-levels.ts";
export * from "../packages/phone-protocol/src/wire.ts";

/** The direct browser event socket's text message. Only sequenced frames have a replay id. */
export interface EventFeedMessage {
  id?: string;
  frame: ServerFrame | { kind: "ping" };
}
