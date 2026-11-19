export interface LaunchWorkCounts {
  children: Array<{ name: string; ms: number }>;
  net: Partial<Record<"accounts" | "cloud" | "updates" | "other", { n: number; ms: number }>>;
}
export function programName(command: unknown, options?: { shell?: boolean }): string;
export function hostKind(target: unknown): "accounts" | "cloud" | "updates" | "other" | null;
export function watchLaunchWork(deps?: {
  childProcess?: Record<string, unknown>;
  sync?: () => void;
  fetchOwners?: Array<{ fetch?: unknown }>;
  now?: () => number;
}): {
  child(command: unknown, ms: number, shell?: boolean): void;
  request(kind: "accounts" | "cloud" | "updates" | "other" | null, ms: number): void;
  counts(): LaunchWorkCounts;
  finish(): LaunchWorkCounts;
};
