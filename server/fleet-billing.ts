import type { FleetBillingMoney, FleetBillingReport, FleetBillingWorkspace } from "../shared/fleet-billing.ts";
import type { FleetDeps, FleetInput, FleetIo } from "./fleet-cli.ts";
import type { FleetLayout, FleetRegistry, FleetStep, FleetWorkspace } from "./fleet.ts";
import type { FleetReseller } from "./fleet-reseller.ts";

export function billingMonth(raw: string | undefined, now: Date): string {
  return raw ?? now.toISOString().slice(0, 7);
}

export function isBillableWorkspace(_workspace: FleetWorkspace, _month: string, _hasUsage: boolean): { billable: boolean; reason: FleetBillingWorkspace["billableReason"] } {
  throw new Error("fleet billing is not implemented yet");
}

export function priceWorkspace(_input: { reseller: FleetReseller; workspace: FleetWorkspace; billable: boolean; users: number | null }): { wholesale: FleetBillingMoney; retail: FleetBillingMoney; marginMinor: number | null } {
  throw new Error("fleet billing is not implemented yet");
}

export function buildBillingReport(_input: { registry: FleetRegistry; layout: FleetLayout; deps: FleetDeps; month: string; detail: boolean; now: Date; maxUsers?: number }): Promise<FleetBillingReport> {
  return Promise.reject(new Error("fleet billing is not implemented yet"));
}

export function billingCsv(_report: FleetBillingReport): string {
  throw new Error("fleet billing is not implemented yet");
}

export function billingText(_report: FleetBillingReport): string {
  throw new Error("fleet billing is not implemented yet");
}

export function runFleetBilling(_input: FleetInput, _io: FleetIo, _deps: FleetDeps): Promise<number> {
  return Promise.reject(new Error("fleet billing is not implemented yet"));
}

export function billingReply(_query: URLSearchParams, _context: { layout: FleetLayout; deps: FleetDeps; now: Date }): Promise<{ status: number; body: unknown }> {
  return Promise.resolve({ status: 501, body: { error: "fleet billing is not implemented yet" } });
}

export function assertBillingEntitled(_input: FleetInput, _deps: FleetDeps): Promise<void> {
  return Promise.reject(new Error("fleet billing is not implemented yet"));
}

export function planFleetRates(_input: FleetInput, _deps: FleetDeps): FleetStep[] {
  throw new Error("fleet rates is not implemented yet");
}

export function snapshotBeforeDelete(_input: FleetInput, _deps: FleetDeps, _now: Date): Promise<void> {
  return Promise.resolve();
}
