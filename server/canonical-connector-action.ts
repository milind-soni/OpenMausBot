/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- this seam validates provider JSON before constructing a typed proposal. */
import type { ActionProposalInput } from "./action-policy.ts";
import type { JsonObject, JsonValue } from "./schema.ts";

/** Stable policy IDs for connector mutations. This closed catalog means an
 * unknown write cannot inherit a permission by name similarity. */
export const CANONICAL_CONNECTOR_OPERATIONS = {
  GMAIL_CREATE_EMAIL_DRAFT: "gmail.drafts.create",
  GMAIL_SEND_EMAIL: "gmail.send",
  GMAIL_REPLY_TO_EMAIL: "gmail.reply",
  GMAIL_REPLY_TO_THREAD: "gmail.reply",
  GMAIL_REPLY_TO_THREAD_BY_ID: "gmail.reply",
  GOOGLECALENDAR_CREATE_EVENT: "calendar.events.create",
  GOOGLECALENDAR_UPDATE_EVENT: "calendar.events.update",
  GOOGLECALENDAR_DELETE_EVENT: "calendar.events.delete",
  GOOGLECALENDAR_RESPOND_TO_EVENT: "calendar.events.rsvp",
  GOOGLECALENDAR_UPDATE_EVENT_ATTENDEE: "calendar.events.rsvp",
  GOOGLECALENDAR_CREATE_AN_EVENT: "calendar.events.create",
  GOOGLECALENDAR_UPDATE_AN_EVENT: "calendar.events.update",
  GOOGLECALENDAR_DELETE_AN_EVENT: "calendar.events.delete",
  GOOGLEDRIVE_CREATE_FILE: "drive.files.create",
  GOOGLEDRIVE_UPLOAD_FILE: "drive.files.create",
  GOOGLEDRIVE_UPDATE_FILE: "drive.files.update",
  GOOGLEDRIVE_UPDATE_FILE_METADATA: "drive.files.update",
  GOOGLEDRIVE_DELETE_FILE: "drive.files.delete",
  GOOGLEDRIVE_MOVE_FILE: "drive.files.move",
  GOOGLEDRIVE_COPY_FILE: "drive.files.copy",
  GOOGLEDRIVE_CREATE_A_FILE: "drive.files.create",
  GOOGLEDRIVE_DELETE_A_FILE: "drive.files.delete",
  GITHUB_CREATE_ISSUE: "github.issues.create",
  GITHUB_CREATE_AN_ISSUE: "github.issues.create",
  GITHUB_UPDATE_ISSUE: "github.issues.update",
  GITHUB_UPDATE_AN_ISSUE: "github.issues.update",
  GITHUB_ADD_ISSUE_COMMENT: "github.issues.comment",
  GITHUB_CREATE_ISSUE_COMMENT: "github.issues.comment",
  GITHUB_CREATE_PULL_REQUEST: "github.pull_requests.create",
  GITHUB_CREATE_A_PULL_REQUEST: "github.pull_requests.create",
  GITHUB_UPDATE_PULL_REQUEST: "github.pull_requests.update",
  GITHUB_MERGE_PULL_REQUEST: "github.pull_requests.merge",
  GITHUB_MERGE_A_PULL_REQUEST: "github.pull_requests.merge",
  GITHUB_CREATE_PULL_REQUEST_REVIEW: "github.pull_requests.review",
} as const satisfies Readonly<Record<string, string>>;

export type CanonicalConnectorOperation = (typeof CANONICAL_CONNECTOR_OPERATIONS)[keyof typeof CANONICAL_CONNECTOR_OPERATIONS];

export type CanonicalConnectorActionResult =
  | { fidelity: "canonical"; action: ActionProposalInput & { operation: CanonicalConnectorOperation } }
  | { fidelity: "invalid"; reason: string }
  | { fidelity: "unsupported" };

const GUARDED_EXECUTOR = "COMPOSIO_MULTI_EXECUTE_TOOL";
const ACCOUNT_FIELDS = new Set(["account", "account_id", "accountId", "connected_account_id", "connectedAccountId"]);
const SECRET_FIELDS = /(?:^|[_-])(access[_-]?token|api[_-]?key|authorization|client[_-]?secret|password|private[_-]?key|refresh[_-]?token|secret|token)$/i;

/** Convert a direct tool call or a single-tool Composio envelope into an
 * immutable, exact-account proposal. Unknown writes remain unsupported. */
export function canonicalConnectorAction(name: string, rawArguments: unknown): CanonicalConnectorActionResult {
  const normalized = normalizeToolName(name);
  if (normalized === GUARDED_EXECUTOR) {
    const envelope = objectValue(rawArguments);
    const tools = envelope?.tools;
    if (!Array.isArray(tools) || tools.length !== 1) {
      return { fidelity: "invalid", reason: "Canonical execution requires exactly one action" };
    }
    const item = objectValue(tools[0]);
    if (!item) return { fidelity: "invalid", reason: "The connector action is malformed" };
    const toolName = typeof item.tool_slug === "string" ? item.tool_slug : typeof item.name === "string" ? item.name : "";
    const operation = operationForTool(toolName);
    if (operation === undefined) return { fidelity: "unsupported" };
    if (operation === null) return { fidelity: "invalid", reason: "The connector action name is malformed" };
    const payload = jsonObject(item.arguments);
    if (!payload) return { fidelity: "invalid", reason: "The connector payload is not valid JSON" };
    return proposalFor(operation, item.account ?? accountField(payload), payload);
  }

  const operation = operationForTool(normalized);
  if (operation === undefined) return { fidelity: "unsupported" };
  if (operation === null) return { fidelity: "invalid", reason: "The connector action name is malformed" };
  const payload = jsonObject(rawArguments);
  if (!payload) return { fidelity: "invalid", reason: "The connector payload is not valid JSON" };
  return proposalFor(operation, accountField(payload), payload);
}

export function canonicalConnectorOperationForTool(name: string): CanonicalConnectorOperation | null {
  return operationForTool(name) ?? null;
}

function proposalFor(operation: CanonicalConnectorOperation, accountValue: unknown, payload: JsonObject): CanonicalConnectorActionResult {
  const accountId = exactAccountId(accountValue);
  if (!accountId) return { fidelity: "invalid", reason: "An exact connected account ID is required" };
  if (containsSecretField(payload)) return { fidelity: "invalid", reason: "Credentials must stay in the provider connection, not an action payload" };
  return { fidelity: "canonical", action: { operation, accountId, payload: omitAccountFields(payload) } };
}

function operationForTool(name: string): CanonicalConnectorOperation | null | undefined {
  const normalized = normalizeToolName(name);
  if (!normalized || normalized.includes(" ")) return null;
  return Object.entries(CANONICAL_CONNECTOR_OPERATIONS).find(([key]) => key === normalized)?.[1];
}

function normalizeToolName(name: string): string { return name.trim().toUpperCase(); }

function accountField(value: JsonObject): JsonValue | undefined {
  for (const key of ACCOUNT_FIELDS) if (key in value) return value[key];
  return undefined;
}

function exactAccountId(value: unknown): string | null {
  const record = objectValue(value);
  const candidate = typeof value === "string" ? value : record && typeof record.id === "string" ? record.id : "";
  const normalized = candidate.trim();
  return /^ca_[A-Za-z0-9_-]{2,200}$/.test(normalized) ? normalized : null;
}

function omitAccountFields(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ACCOUNT_FIELDS.has(key)));
}

function containsSecretField(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => SECRET_FIELDS.test(key) || containsSecretField(child));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function jsonObject(value: unknown): JsonObject | null { return isJsonObject(value) ? value : null; }

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const object = objectValue(value);
  return object !== null && Object.values(object).every(isJsonValue);
}
