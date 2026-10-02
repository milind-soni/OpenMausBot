export type CloudMachineStatus = "provisioning" | "ready" | "stopped" | "payment-problem" | "failed";
export type CloudSetupStep = "reserving" | "storage" | "starting" | "checking";
/** What the renderer may know about the person's Cloud machine: never a code. */
export interface CloudMachine {
  status: CloudMachineStatus;
  origin?: string;
  /** While setting up, when the Admin says: the step it is at, and whether it is slow. */
  setup?: { step: CloudSetupStep; slow?: true };
  /** A failed setup's next automatic try, when the Admin says. */
  retryAt?: number;
  /** The volume now and the most the plan lets it grow to, when the Admin says. */
  disk?: { gb: number; maxGb: number };
}
/** A payment received but not yet linked to this account: nobody pays twice. */
export interface CloudPurchase { state: "confirming" | "held"; tier?: string; paidAt?: number }
export interface CloudHomeGrant { origin: string; code: string; expiresAt: number }
export interface CloudHomeTarget { origin: string; grant: CloudHomeGrant | null }
/** `largest`: the top plan, so nobody is pointed at a larger one. */
export interface CloudPlanDisk { maxBytes: number; volumeBytes?: number; startBytes?: number; largest?: true }
export interface RememberedCloudHome { accountId: string; origin: string }
export declare const CLOUD_HOME_NAME: string;
export declare const CLOUD_MACHINE_STATUSES: readonly CloudMachineStatus[];
export declare const CLOUD_MACHINE_CONNECTABLE: readonly CloudMachineStatus[];
export declare const CLOUD_SETUP_STEPS: readonly CloudSetupStep[];
export declare function parseCloudSummary(input: unknown): CloudMachine | null;
export declare function parseCloudPurchase(input: unknown): CloudPurchase | null;
export declare function cloudPlanDisk(state: unknown): CloudPlanDisk | null;
export declare function rememberedCloudHome(previous: RememberedCloudHome | null, state: unknown): RememberedCloudHome | null;
export declare function isCloudHomeEntry(entry: { origin?: string } | null | undefined, known?: { homeOrigin?: string | null; remembered?: RememberedCloudHome | null }): boolean;
export declare function parsePairingGrant(input: unknown, origin: string, now: number): CloudHomeGrant | null;
export declare function withCloudHome<T extends { environments: Array<{ id: string; name: string; origin: string }>; activeId: string }>(state: T, machine: CloudMachine | null | undefined, makeId: () => string): T;
export declare function cloudHomeConnectUrl(target: CloudHomeTarget, now: number): string;
