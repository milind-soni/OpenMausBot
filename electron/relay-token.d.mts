// Types for relay-token.mjs as the headless server uses it (server/phone-relay.ts). Keep in step with the implementation.
export interface RelayGrant {
  token: string;
  hostId: string;
  nodes: string[];
  expiresAt: number;
  refreshAfter: number;
}

export declare function validRelayGrant(payload: unknown): RelayGrant | null;

export interface RelayTokenService {
  readonly grant: RelayGrant | null;
  readonly running: boolean;
  start(): void;
  stop(): void;
  refreshNow(): Promise<void>;
}

export declare function createRelayTokenService(options: {
  fetchGrant: () => Promise<unknown>;
  onGrant: (grant: RelayGrant | null) => void;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
}): RelayTokenService;
