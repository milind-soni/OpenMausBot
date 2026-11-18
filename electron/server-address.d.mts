export declare const PAIRING_CODE_ALPHABET: string;
export declare const PAIRING_CODE_LENGTH: number;
export declare const DEFAULT_PORT: number;
export declare const EXAMPLE_ADDRESS: string;

export type PairingCodeProblem = "emailCode" | "oldCode" | "scriptKey" | "notACode";
export type PairingCodeInput =
  | { kind: "code"; code: string }
  | { kind: "credential"; credential: string }
  | { kind: "wrong"; problem: PairingCodeProblem }
  | { kind: "empty" };

export type ServerInputProblem = "empty" | "codeOnly" | "publicHttp" | "phoneLink" | "notAnAddress" | PairingCodeProblem;
export type ServerInput =
  | { ok: true; candidates: string[]; code: string | null; credential: string | null }
  | { ok: false; problem: ServerInputProblem; code?: string; host?: string };

export type ServerTransport = "https" | "tailscale" | "private-http" | "loopback";

export declare function isLoopbackHost(host: string): boolean;
export declare function isPrivateHost(host: string): boolean;
export declare function serverTransport(origin: string): ServerTransport;
export declare function allowedServerOrigin(origin: string): boolean;
export declare function normalizePairingCode(input: string): string;
export declare function formatPairingCode(code: string): string;
export declare function readPairingCode(raw: string): PairingCodeInput;
export declare function parseServerInput(addressInput: string, codeInput?: string): ServerInput;
export declare function pairingPageUrl(origin: string, secret: string | null): string;
