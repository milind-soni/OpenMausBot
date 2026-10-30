import type { Duplex } from "node:stream";

export type ChromeDoorOpened = { socket: Duplex } | { failed: "no-chrome" | "timeout" | "unreachable" };
export interface ChromeDoor { open(): Promise<ChromeDoorOpened> }
export declare const DEVTOOLS_FILE: "DevToolsActivePort";
export declare const MAX_HEAD: number;
export declare function chromeDataDirs(options: { platform: string; home?: string; localAppData?: string }): string[];
export declare function parseDevtoolsActivePort(text: string): { port: number; path: string } | null;
export declare function rewriteHandshake(head: string, target: { port: number; path: string }): string | null;
export declare function createChromeDoor(options?: {
  dirs?: string[];
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  connect?: (options: { host: string; port: number }) => import("node:net").Socket;
  connectMs?: number;
}): ChromeDoor;
