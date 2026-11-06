/** Money is whole minor units (cents) in `currency`; a figure is `null` when it cannot be known. */
export interface FleetBillingMoney {
  /** The per-workspace charge; 0 when the workspace is not billable this month, `null` when whether it is billable is unknown. */
  workspaceMinor: number | null;
  /** Users times the per-user rate; `null` when the workspace's ledger was unavailable. */
  usersMinor: number | null;
  totalMinor: number | null;
}

/** One person who asked a workspace something during the month. */
export interface FleetBillingUser {
  /** A lowercased email, or `device:` and a device label. */
  id: string;
  kind: "email" | "device";
  /** Turns this person started. */
  asked: number;
  /** Turns whose cost is attributed to this person. */
  attributed: number;
  costUsd: number | null;
}

export interface FleetBillingWorkspace {
  /** `slug@createdAt`, so a reused name is a different workspace. */
  workspaceId: string;
  slug: string;
  host: string;
  status: string;
  /**
   * Whether the workspace is charged for the month. `null` when the ledger could not be read and the workspace was not
   * running that month: usage might still make it billable, so the answer is unknown, not no.
   */
  billable: boolean | null;
  /** Why: it ran at some point in the month, it had usage, neither, or that cannot be known (`unknown`, with `billable` null). */
  billableReason: "running" | "usage" | "none" | "unknown";
  ledger: "ok" | "unavailable";
  unavailableReason?: string;
  turns: number | null;
  costUsd: number | null;
  /** Distinct human askers. */
  activeUsers: number | null;
  /** Sign-in list sizes, not usage. */
  provisionedSeats: { emails: number; domains: number } | null;
  /** What the reseller owes the vendor. */
  wholesale: FleetBillingMoney;
  /** What the reseller charges its customer. */
  retail: FleetBillingMoney;
  marginMinor: number | null;
  /** Only with `--detail`. */
  users?: FleetBillingUser[];
}

export interface FleetBillingTotals {
  workspaces: number;
  activeUsers: number | null;
  wholesaleMinor: number | null;
  retailMinor: number | null;
  marginMinor: number | null;
}

/**
 * One reseller's month, built from the usage ledgers the workspaces report about themselves: evidence for an invoice, not
 * enforcement. Totals are the sum of the printed lines and are `null` when any line they depend on is.
 */
export interface FleetBillingReport {
  version: 1;
  reseller: { name: string };
  /** `YYYY-MM`, UTC. */
  month: string;
  currency: string;
  generatedAt: string;
  /** False while the month is still running: the report is "as of" `generatedAt`. */
  final: boolean;
  basis: "tenant-reported-ledger";
  /** False when any workspace's ledger was unavailable or a closing snapshot for the month had to be skipped. */
  complete: boolean;
  /** Closing snapshots of this month that were damaged or in another currency, each with the reason; absent when none. */
  skippedSnapshots?: string[];
  workspaces: FleetBillingWorkspace[];
  totals: FleetBillingTotals;
}
