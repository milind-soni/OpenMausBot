// Types for companion-origin-gateway.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
export declare const MANAGED_COMPANION_ORIGIN_HOST: string;
export declare const MANAGED_COMPANION_ORIGIN_PORT: number;

export interface CompanionOriginEndpoint {
  readonly pid: number;
  readonly socketPath: string;
  readonly directory: string | null;
}

export declare function validCompanionOriginTarget(target: unknown, platform?: NodeJS.Platform): boolean;
export declare function createCompanionOriginEndpoint(options?: {
  platform?: NodeJS.Platform;
  processId?: number;
  temporaryRoot?: string;
}): CompanionOriginEndpoint;
export declare function cleanupCompanionOriginEndpoint(endpoint: CompanionOriginEndpoint): void;
