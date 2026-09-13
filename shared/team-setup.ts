import type { ModelSelection } from "../server/contracts.ts";

export interface TeamSetupFields {
  name?: string;
  title?: string;
  description?: string;
  soul?: string;
  section?: string;
  modelSelection?: ModelSelection;
}

export interface TeamSetupOperation {
  action: "create" | "update";
  botId: string;
  threadId?: string;
  fields: TeamSetupFields;
  expectedRevision?: string;
}

export interface TeamSetupResult {
  state: "applied" | "denied" | "cancelled" | "failed";
  bots: Array<{ id: string; name: string; action: "created" | "updated" | "deleted"; section?: string; modelSelection?: ModelSelection }>;
  newTeams: string[];
  error?: string;
}

/** The complete, reviewed operation. It never accepts executable permissions. */
export interface TeamSetupRequest {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  reason: string;
  createdAt: number;
  requesterRevision: string;
  operations: TeamSetupOperation[];
  newTeams: string[];
  deletion?: { botId: string; name: string; expectedRevision: string };
  result?: TeamSetupResult;
  resumed?: boolean;
}
