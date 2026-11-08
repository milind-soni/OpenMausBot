export { setTimeout as sleep } from "node:timers/promises";
export type CloudProviderName = "boxd" | "boat";
export type CloudMachine = {
  provider: CloudProviderName;
  id: string;
  state: "running" | "stopped" | "starting" | "unknown";
  name?: string;
  address?: string;
  createdAt?: number;
};
export type CloudCredentials = { provider: CloudProviderName; apiKey: string };
export type CloudMachineInput = CloudCredentials & { id: string };
export type CloudCreateInput = CloudCredentials & { idempotencyKey: string; name: string };
export type CloudExecInput = CloudMachineInput & { command: string; env?: Record<string, string>; timeoutSeconds: number };
export type CloudCommandResult = { exitCode: number; stdout: string; stderr: string };
export type CloudUsage = { status: "available" | "unknown"; balance?: number; unit?: string; balanceScope?: "credit_wallet" | "overage_wallet"; label?: string; error?: string };
export type CloudOperation = "create" | "start" | "extend" | "get" | "exec" | "stop" | "delete" | "usage";
export type CloudErrorCategory = "auth" | "credit" | "rate_limit" | "service" | "conflict" | "not_found" | "invalid_request" | "protocol";

// Never attach a raw SDK/fetch error: its message, request, or cause can contain credentials.
export class CloudProviderError extends Error {
  readonly name = "CloudProviderError";
  constructor(
    readonly provider: CloudProviderName,
    readonly operation: CloudOperation,
    readonly category: CloudErrorCategory,
    message: string,
    readonly outcome: "known" | "unknown" = "known",
    readonly details: { machineId?: string; operationId?: string; httpStatus?: number; grpcCode?: number; code?: string } = {},
  ) { super(message); }
  get machineId() { return this.details.machineId; }
  get operationId() { return this.details.operationId; }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function mutation(operation: CloudOperation) { return ["create", "start", "extend", "exec", "stop", "delete"].includes(operation); }
export function protocol(provider: CloudProviderName, operation: CloudOperation, machineId?: string): never {
  throw new CloudProviderError(provider, operation, "protocol", `${provider} returned an incomplete or unexpected ${operation} response`, mutation(operation) ? "unknown" : "known", { machineId });
}
export function requireCredentials(input: CloudCredentials, operation: CloudOperation) {
  if (input.provider !== "boat" && input.provider !== "boxd") throw new CloudProviderError(input.provider, operation, "invalid_request", "Unknown cloud provider");
  if (typeof input.apiKey !== "string" || !input.apiKey.trim() || /[\s\x00-\x1f\x7f]/.test(input.apiKey)) {
    throw new CloudProviderError(input.provider, operation, "auth", "An explicit cloud API key is required");
  }
}
export function requireMachine(input: CloudMachineInput, operation: CloudOperation) {
  requireCredentials(input, operation);
  if (typeof input.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.id)) {
    throw new CloudProviderError(input.provider, operation, "invalid_request", "A valid cloud machine ID is required");
  }
}
export function requireCreate(input: CloudCreateInput) {
  requireCredentials(input, "create");
  if (typeof input.idempotencyKey !== "string" || !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 120 || /[\x00-\x1f\x7f]/.test(input.name)) {
    throw new CloudProviderError(input.provider, "create", "invalid_request", "Create needs an opaque idempotency key and a name of at most 120 characters");
  }
}
export function requireExec(input: CloudExecInput) {
  requireMachine(input, "exec");
  if (typeof input.command !== "string" || !input.command.trim() || input.command.includes("\0") || Buffer.byteLength(input.command) > 65536 || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 86400) {
    throw new CloudProviderError(input.provider, "exec", "invalid_request", "Command must be nonempty (at most 64 KiB); timeout must be 1–86400 seconds");
  }
  if (input.env !== undefined && (input.env === null || typeof input.env !== "object" || Array.isArray(input.env) || Object.entries(input.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.includes("\0")) || Buffer.byteLength(JSON.stringify(input.env)) > 65536)) {
    throw new CloudProviderError(input.provider, "exec", "invalid_request", "Environment must contain valid variable names and string values (at most 64 KiB)");
  }
}
export function timestamp(value: unknown): number | undefined {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}
export function commandResult(provider: CloudProviderName, value: unknown, machineId: string): CloudCommandResult {
  const data = record(value);
  if (!Number.isInteger(data.exitCode) || (data.exitCode as number) < 0 || (data.exitCode as number) > 255 || typeof data.stdout !== "string" || typeof data.stderr !== "string") protocol(provider, "exec", machineId);
  return { exitCode: data.exitCode as number, stdout: data.stdout as string, stderr: data.stderr as string };
}
export function redactOutput(result: CloudCommandResult, secrets: string[]): CloudCommandResult {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const redact = (text: string) => values.reduce((value, secret) => value.split(secret).join("[redacted]"), text);
  return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
}
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// The command and env arrive over stdin/a private file, never as shell assignments.
// Reset stdin before exec so the child cannot read another copy of its credentials.
export const EXEC_PYTHON = "import json,os,sys; p=json.load(sys.stdin); env={k:os.environ[k] for k in ('PATH','HOME','USER','LOGNAME','LANG') if k in os.environ}; env.update(p['env']); os.dup2(os.open('/dev/null',os.O_RDONLY),0); os.execvpe('bash',['bash','-c',p['command']],env)";
export function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
