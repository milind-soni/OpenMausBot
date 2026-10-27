import type { Duplex } from "node:stream";

export declare function linkPath(computerId: string): string;
export declare const LINK_ASLEEP: number;
export declare const LINK_ENDED: number;
export declare const STREAM_WINDOW: number;
export declare const MAX_CHUNK: number;
export declare const MAX_STREAMS: number;
export declare const OPEN_MS: number;

/** A stream My Cloud asked for: joined to the browser's own connection once the computer has connected it. */
export interface LinkStream { join(socket: Duplex, early?: readonly Buffer[]): void; cancel(): void }
export type LinkOpened = LinkStream | { refused: string } | { failed: string } | { gone: true };
export interface LinkMux {
  receive(data: string | Buffer | ArrayBuffer | Uint8Array): void;
  open(target: { host: string; port: number } | { chrome: true }): Promise<LinkOpened>;
  readonly size: number;
  close(): void;
}
export declare function createLinkMux(options: {
  send(frame: string | Buffer): void;
  accept?: ((target: { host: unknown; port: unknown } | { chrome: true }) => Promise<{ socket?: Duplex; refused?: string; failed?: string }>) | null;
  window?: number;
  maxStreams?: number;
  openMs?: number;
  traffic?: () => void;
}): LinkMux;
