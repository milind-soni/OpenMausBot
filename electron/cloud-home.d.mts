export type CloudMachineStatus = "provisioning" | "ready" | "stopped" | "payment-problem" | "failed";
/** What the renderer may know about the person's Cloud machine: never a code. */
export interface CloudMachine {
  status: CloudMachineStatus;
  origin?: string;
}
export interface CloudHomeGrant { origin: string; code: string; expiresAt: number }
export interface CloudHomeTarget { origin: string; grant: CloudHomeGrant | null }
export declare const CLOUD_HOME_NAME: string;
export declare const CLOUD_MACHINE_STATUSES: readonly CloudMachineStatus[];
export declare const CLOUD_MACHINE_CONNECTABLE: readonly CloudMachineStatus[];
export declare function parseCloudSummary(input: unknown): CloudMachine | null;
export declare function parsePairingGrant(input: unknown, origin: string, now: number): CloudHomeGrant | null;
export declare function withCloudHome<T extends { environments: Array<{ id: string; name: string; origin: string }>; activeId: string }>(state: T, machine: CloudMachine | null | undefined, makeId: () => string): T;
export declare function cloudHomeConnectUrl(target: CloudHomeTarget, now: number): string;
