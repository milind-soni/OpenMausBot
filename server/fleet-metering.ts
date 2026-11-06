import type { FleetWorkspace } from "./fleet.ts";
import type { FleetWorkspaceStatus } from "./fleet-reseller.ts";
import type { PeopleResult } from "./fleet-tenant-io.ts";

export type { PeopleResult } from "./fleet-tenant-io.ts";

export function recordWorkspaceEvent(workspace: FleetWorkspace, _status: FleetWorkspaceStatus, _at: string): FleetWorkspace {
  return workspace;
}

export function meterLedgerText(_text: string, _month: string, _maxUsers?: number): PeopleResult {
  throw new Error("metering a ledger is not implemented yet");
}
