import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Duplex } from "node:stream";

export type McpApproval = { kind: "url"; port: number } | { kind: "command"; fingerprint: string };
export type McpPromptTarget = { kind: "url"; port: number } | { kind: "command"; command: string; env: string[] };
export type McpDoorOpened =
  | { socket: Duplex }
  | { refused: "needs-approval" | "declined" | "no-window" }
  | { failed: "bad-port" | "no-server" | "changed" | "unreachable" | "timeout" | "spawn-failed" };
export interface McpDoor {
  open(target: { name: unknown; port?: unknown; fingerprint?: unknown }): Promise<McpDoorOpened>;
  close(): void;
}
export declare function shownCommand(command: string, args: string[]): string;
export declare function createMcpDoor(options: {
  approvals: { read(): Record<string, McpApproval>; write(next: Record<string, McpApproval>): void };
  prompt(ask: { name: string; target: McpPromptTarget }): Promise<boolean>;
  ownPorts(): Promise<number[]>;
  definition(name: string): Promise<{ command: string; args: string[]; env: Record<string, string> } | null>;
  canAsk?: () => boolean;
  environment?: () => Promise<Record<string, string>>;
  home?: string;
  connect?: (options: { host: string; port: number }) => import("node:net").Socket;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => number;
  platform?: string;
  declineMs?: number;
  connectMs?: number;
}): McpDoor;
