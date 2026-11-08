import { createBoxd, deleteBoxd, executeBoxd, findBoxd, getBoxd, startBoxd, stopBoxd, usageBoxd } from "./execution-cloud/boxd";
import { createBoat, deleteBoat, deletionStatusBoat, executeBoat, extendBoat, findBoat, getBoat, startBoat, stopBoat, usageBoat, type CloudDeletionStatus } from "./execution-cloud/boat";
import { CloudProviderError, redactOutput, requireCreate, requireCredentials, requireExec, requireMachine, type CloudCommandResult, type CloudCreateInput, type CloudCredentials, type CloudExecInput, type CloudMachine, type CloudMachineInput, type CloudUsage } from "./execution-cloud/shared";

export { CloudProviderError } from "./execution-cloud/shared";
export type { CloudProviderName, CloudMachine, CloudErrorCategory, CloudOperation, CloudUsage } from "./execution-cloud/shared";
export type { CloudDeletionStatus } from "./execution-cloud/boat";

// Server-only control plane: credentials must never enter a browser bundle.
// The controller owns authorization, offline-only routing, provisioning journal,
// stable idempotency keys, and the decision to stop/hand off an uncertain run.
export async function createCloudMachine(input: CloudCreateInput): Promise<CloudMachine> {
  requireCreate(input);
  return input.provider === "boxd" ? createBoxd(input) : createBoat(input);
}
// Null means only "not found now", NEVER permission to retry an unknown create.
export async function findCloudMachine(input: CloudCreateInput): Promise<CloudMachine | null> {
  requireCreate(input);
  return input.provider === "boxd" ? findBoxd(input) : findBoat(input);
}
export async function getCloudMachine(input: CloudMachineInput): Promise<CloudMachine> {
  requireMachine(input, "get");
  return input.provider === "boxd" ? getBoxd(input) : getBoat(input);
}
export async function startCloudMachine(input: CloudMachineInput): Promise<CloudMachine> {
  requireMachine(input, "start");
  return input.provider === "boxd" ? startBoxd(input) : startBoat(input);
}
export async function executeCloudCommand(input: CloudExecInput): Promise<CloudCommandResult> {
  requireExec(input);
  const result = await (input.provider === "boxd" ? executeBoxd(input) : executeBoat(input));
  return redactOutput(result, [input.apiKey, ...Object.values(input.env ?? {})]);
}
export async function stopCloudMachine(input: CloudMachineInput): Promise<void> {
  requireMachine(input, "stop");
  await (input.provider === "boxd" ? stopBoxd(input) : stopBoat(input));
}
export async function deleteCloudMachine(input: CloudMachineInput): Promise<void> {
  requireMachine(input, "delete");
  await (input.provider === "boxd" ? deleteBoxd(input) : deleteBoat(input));
}
export async function getCloudDeletionStatus(input: { provider: "boat"; apiKey: string; operationId: string }): Promise<CloudDeletionStatus> {
  requireCredentials(input, "delete");
  if (input.provider !== "boat") throw new CloudProviderError(input.provider, "delete", "invalid_request", "Only Boat exposes deletion operation IDs");
  return deletionStatusBoat(input.apiKey, input.operationId);
}
export async function extendCloudMachine(input: { provider: "boat"; apiKey: string; id: string; ttlSeconds: number }): Promise<void> {
  requireMachine(input, "extend");
  if (input.provider !== "boat") throw new CloudProviderError(input.provider, "extend", "invalid_request", "Only Boat exposes an auto-stop TTL");
  await extendBoat(input);
}
export async function cloudAccountUsage(input: CloudCredentials): Promise<CloudUsage> {
  requireCredentials(input, "usage");
  return input.provider === "boxd" ? usageBoxd(input.apiKey) : usageBoat(input.apiKey);
}
