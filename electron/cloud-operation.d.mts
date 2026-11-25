/** What the Admin says while an operation of its own has a Cloud down (cloud-operation.mjs). `kind`: one of
 * CLOUD_OPERATION_KINDS, or a newer one this app reads as "restarting"; `until`: its own deadline, past which the Admin's alert
 * has gone out; `expectedAt`: when it is usually back, only where the Admin measured it; `backup`: the update backs the whole
 * Cloud up first; `bigger`: a resize to a bigger size. Times in epoch ms. */
export interface CloudOperation { kind: string; since: number; until: number; expectedAt?: number; backup?: true; bigger?: true }
export declare const CLOUD_OPERATION_KINDS: readonly string[];
export declare const OPERATION_REFRESH_MS: number;
export declare function parseCloudOperation(input: unknown): CloudOperation | null;
export declare function cloudOperationAt(state: unknown, origin: string | null | undefined): CloudOperation | null;
export declare function anyOperation(machine: { operation?: CloudOperation } | null | undefined, clouds: unknown): boolean;
