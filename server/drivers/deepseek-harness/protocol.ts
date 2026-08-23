import { z } from "zod";

// DSH treats rpcId as an opaque echo token. The official schema deliberately
// accepts every string (including an empty one), so the transport must not
// invent a narrower alphabet than the Host API it speaks.
const RPC_ID = z.string();
const API_METHOD = z.string().min(3).max(160).regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/);
const ERROR_MESSAGE = z.string();
export const dshJsonValueSchema = z.json();
export type DshJsonValue = z.infer<typeof dshJsonValueSchema>;

const emptyDetails = z.object({});
const dshRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("bad-request"), message: ERROR_MESSAGE, details: z.object({ issues: z.array(z.unknown()) }) }),
  z.object({ code: z.literal("cancelled"), message: ERROR_MESSAGE, details: emptyDetails }),
  z.object({ code: z.literal("session-not-found"), message: ERROR_MESSAGE, details: z.object({ sessionId: z.string() }) }),
  z.object({ code: z.literal("model-unavailable"), message: ERROR_MESSAGE, details: z.object({ provider: z.string(), model: z.string() }) }),
  z.object({ code: z.literal("session-conflict"), message: ERROR_MESSAGE, details: z.object({ sessionId: z.string(), requestedCwd: z.string(), existingCwd: z.string().optional() }) }),
  z.object({ code: z.literal("invalid-time-zone"), message: ERROR_MESSAGE, details: z.object({ value: z.string() }) }),
  z.object({ code: z.literal("workspace-attach-failed"), message: ERROR_MESSAGE, details: z.object({ sessionId: z.string(), workspaceId: z.string() }) }),
  z.object({ code: z.literal("workspace-not-found"), message: ERROR_MESSAGE, details: z.object({ workspaceId: z.string() }) }),
  z.object({ code: z.literal("workspace-invalid-path"), message: ERROR_MESSAGE, details: z.object({ path: z.string() }) }),
  z.object({ code: z.literal("workspace-name-conflict"), message: ERROR_MESSAGE, details: z.object({ name: z.string() }) }),
  z.object({ code: z.literal("workspace-move-invalid"), message: ERROR_MESSAGE, details: z.object({ workspaceId: z.string(), sessionId: z.string(), beforeSessionId: z.string().optional() }) }),
  z.object({ code: z.literal("directory-unreadable"), message: ERROR_MESSAGE, details: z.object({ path: z.string() }) }),
  z.object({ code: z.literal("directory-exists"), message: ERROR_MESSAGE, details: z.object({ path: z.string() }) }),
  z.object({ code: z.literal("directory-create-failed"), message: ERROR_MESSAGE, details: z.object({ path: z.string() }) }),
  z.object({ code: z.literal("directory-picker-unavailable"), message: ERROR_MESSAGE, details: z.object({ capability: z.string() }) }),
  z.object({ code: z.literal("agent-preset-read-only"), message: ERROR_MESSAGE, details: z.object({ agentPreset: z.string(), reason: z.string() }) }),
  z.object({ code: z.literal("agent-preset-locked"), message: ERROR_MESSAGE, details: z.object({ sessionId: z.string(), agentPreset: z.string() }) }),
  z.object({ code: z.literal("agent-preset-conflict"), message: ERROR_MESSAGE, details: z.object({ sessionId: z.string(), requestedPreset: z.string(), existingPreset: z.string().optional() }) }),
  z.object({ code: z.literal("agent-preset-not-found"), message: ERROR_MESSAGE, details: z.object({ agentPreset: z.string(), available: z.array(z.string()) }) }),
  z.object({ code: z.literal("agent-preset-invalid"), message: ERROR_MESSAGE, details: z.object({ agentPreset: z.string(), reason: z.string() }) }),
  z.object({ code: z.literal("agent-busy"), message: ERROR_MESSAGE, details: z.object({ reason: z.string() }) }),
  z.object({ code: z.literal("attachment-error"), message: ERROR_MESSAGE, details: z.object({ reason: z.string() }) }),
  z.object({ code: z.literal("queue-item-not-found"), message: ERROR_MESSAGE, details: z.object({ itemId: z.string() }) }),
  z.object({ code: z.literal("steer-unavailable"), message: ERROR_MESSAGE, details: z.object({ itemId: z.string() }) }),
  z.object({ code: z.literal("command-error"), message: ERROR_MESSAGE, details: emptyDetails }),
  z.object({ code: z.literal("unknown-command"), message: ERROR_MESSAGE, details: emptyDetails }),
  z.object({ code: z.literal("settings-rejected"), message: ERROR_MESSAGE, details: z.object({ ns: z.string() }) }),
  z.object({ code: z.literal("settings-conflict"), message: ERROR_MESSAGE, details: z.object({ ns: z.string(), expected: z.number(), actual: z.number() }) }),
  z.object({ code: z.literal("credential-rejected"), message: ERROR_MESSAGE, details: z.object({ ref: z.string() }) }),
  z.object({ code: z.literal("model-discovery-failed"), message: ERROR_MESSAGE, details: z.object({ settingsNs: z.string(), baseURL: z.string().optional() }) }),
  z.object({ code: z.literal("title-invalid"), message: ERROR_MESSAGE, details: z.object({ sessionId: z.string() }) }),
  z.object({ code: z.literal("fork-unavailable"), message: ERROR_MESSAGE, details: z.object({ sessionId: z.string() }) }),
  z.object({ code: z.literal("subagent-parent-unavailable"), message: ERROR_MESSAGE, details: z.object({ parentSessionId: z.string() }) }),
  z.object({ code: z.literal("subagent-not-found"), message: ERROR_MESSAGE, details: z.object({ parentSessionId: z.string(), childSessionId: z.string() }) }),
  z.object({ code: z.literal("subagent-catalog-diagnostic"), message: ERROR_MESSAGE, details: z.object({ parentSessionId: z.string(), childSessionId: z.string(), reason: z.enum(["corrupt", "unsupported", "unavailable"]) }) }),
  z.object({ code: z.literal("subagent-not-resumable"), message: ERROR_MESSAGE, details: z.object({ childSessionId: z.string() }) }),
  z.object({ code: z.literal("subagent-unauthorized"), message: ERROR_MESSAGE, details: z.object({ childSessionId: z.string() }) }),
  z.object({ code: z.literal("subagent-delivery-unavailable"), message: ERROR_MESSAGE, details: z.object({ childSessionId: z.string() }) }),
  z.object({ code: z.literal("internal"), message: ERROR_MESSAGE, details: emptyDetails }),
]);

export const dshRpcResultSchema = z.union([
  // Official void methods omit `value` entirely rather than serializing null.
  z.object({ ok: z.literal(true), value: dshJsonValueSchema.optional() }),
  z.object({ ok: z.literal(false), error: dshRpcErrorSchema }),
]);
export type DshRpcResult = z.infer<typeof dshRpcResultSchema>;

export const dshClientRequestSchema = z.object({
  type: z.literal("client-request"),
  rpcId: RPC_ID,
  method: z.string(),
  payload: dshJsonValueSchema,
});
export type DshClientRequest = z.infer<typeof dshClientRequestSchema>;

export const dshServerResponseSchema = z.object({
  type: z.literal("server-response"),
  rpcId: RPC_ID,
  result: dshRpcResultSchema,
});
export type DshServerResponse = z.infer<typeof dshServerResponseSchema>;

export const dshServerRequestSchema = z.object({
  type: z.literal("server-request"),
  rpcId: RPC_ID,
  method: z.string(),
  payload: dshJsonValueSchema,
});
export type DshServerRequest = z.infer<typeof dshServerRequestSchema>;

export const dshClientResponseSchema = z.object({
  type: z.literal("client-response"),
  rpcId: RPC_ID,
  result: dshRpcResultSchema,
});
export type DshClientResponse = z.infer<typeof dshClientResponseSchema>;

export const dshReceiptSchema = z.union([
  z.object({ accepted: z.literal(true) }),
  z.object({ accepted: z.literal(false), reason: z.enum(["not-pending", "bad-response"]) }),
]);
export type DshReceipt = z.infer<typeof dshReceiptSchema>;

const sessionIdSchema = z.string().min(1);
const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
});
const modelReasoningEffortSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});
const modelProviderGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    reasoning: z.object({ efforts: z.array(modelReasoningEffortSchema).min(1), defaultEffort: z.string().min(1).optional() }).optional(),
  })),
});
const modelCatalogFailureSchema = z.object({ id: z.string().min(1), name: z.string().min(1), message: z.string() });
const agentPresetEntrySchema = z.object({
  id: z.string().min(1),
  trust: z.enum(["system", "user"]),
  isDefault: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
  broken: z.string().min(1).optional(),
});
const configurableProviderSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  active: z.boolean(),
  declared: z.boolean().optional(),
});
const discoveredModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});
const settingsNamespaceSchema = z.object({
  ns: z.string().min(1),
  schema: z.unknown(),
  value: z.unknown(),
  base: z.unknown().optional(),
  user: z.unknown().optional(),
  applies: z.enum(["live", "restart"]),
  secrets: z.array(z.object({ path: z.array(z.string()), set: z.boolean() })),
  revision: z.number(),
});

const dshUnaryValueSchemas = {
  "session.create": z.object({ sessionId: sessionIdSchema, agentPreset: z.string().optional() }),
  "session.selectModel": z.object({ selected: modelSelectionSchema }),
  "session.prompt": z.object({
    accepted: z.literal(true),
    command: z.object({ kind: z.literal("success"), text: z.string().optional() }).optional(),
  }),
  "session.cancel": z.object({ accepted: z.literal(true) }),
  "host.describe": z.object({
    version: z.string(),
    cwd: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
    attachedSessions: z.number().int().nonnegative(),
    home: z.string(),
    canOpenPath: z.boolean(),
  }),
  "llm.providers": z.object({ providers: z.array(configurableProviderSchema) }),
  "llm.models": z.object({ groups: z.array(modelProviderGroupSchema), failures: z.array(modelCatalogFailureSchema) }),
  "llm.discoverModels": z.object({ models: z.array(discoveredModelSchema) }),
  "settings.describe": z.object({ writable: z.boolean(), hasDocument: z.boolean(), namespaces: z.array(settingsNamespaceSchema) }),
  "settings.mutate": settingsNamespaceSchema,
  "agentPreset.list": z.object({ presets: z.array(agentPresetEntrySchema), authorable: z.boolean(), hasDocument: z.boolean() }),
} as const;

export function dshUnaryValueSchema(method: string): z.ZodType | null {
  switch (method) {
    case "session.create": return dshUnaryValueSchemas["session.create"];
    case "session.selectModel": return dshUnaryValueSchemas["session.selectModel"];
    case "session.prompt": return dshUnaryValueSchemas["session.prompt"];
    case "session.cancel": return dshUnaryValueSchemas["session.cancel"];
    case "host.describe": return dshUnaryValueSchemas["host.describe"];
    case "llm.providers": return dshUnaryValueSchemas["llm.providers"];
    case "llm.models": return dshUnaryValueSchemas["llm.models"];
    case "llm.discoverModels": return dshUnaryValueSchemas["llm.discoverModels"];
    case "settings.describe": return dshUnaryValueSchemas["settings.describe"];
    case "settings.mutate": return dshUnaryValueSchemas["settings.mutate"];
    case "agentPreset.list": return dshUnaryValueSchemas["agentPreset.list"];
    default: return null;
  }
}

const sessionEventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  time: z.number(),
  data: z.unknown(),
  sourceEventSeqs: z.array(z.number()).optional(),
  surfaceOp: z.unknown().optional(),
  ignorable: z.literal(true).optional(),
});
const questionItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  intent: z.discriminatedUnion("kind", [z.object({ kind: z.literal("plan-review"), approve: z.string() })]).optional(),
});
const contentBlockSchema = z.looseObject({ type: z.string() });
const toolEventViewSchema = z.discriminatedUnion("for", [
  z.object({ for: z.literal("call"), view: z.looseObject({ card: z.string() }) }),
  z.object({ for: z.literal("result"), view: z.looseObject({ card: z.string() }) }),
]);
const queuedMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["system", "user", "assistant"]),
  content: z.array(contentBlockSchema),
  source: z.looseObject({ kind: z.string() }),
});
const queuedItemSchema = z.object({
  id: z.string().min(1),
  placement: z.enum(["queued", "steering", "context"]),
  message: queuedMessageSchema,
});
const taskViewSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["running", "stopping", "completed", "killed", "failed"]),
  detail: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
});
const workspaceViewSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionIdSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Exact DSH mux payload union. Unknown session-event data remains wide by contract. */
export const dshMuxPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session/event"), sessionId: sessionIdSchema, event: sessionEventSchema, view: toolEventViewSchema.optional() }),
  z.object({ type: z.literal("session/subscribed"), sessionId: sessionIdSchema, lastSeq: z.number().int() }),
  z.object({ type: z.literal("approval/requested"), sessionId: sessionIdSchema, approvalId: z.string().min(1), toolName: z.string(), callId: z.string().optional(), reason: z.string().optional() }),
  z.object({ type: z.literal("approval/resolved"), sessionId: sessionIdSchema, approvalId: z.string().min(1), outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]) }),
  z.object({ type: z.literal("question/requested"), sessionId: sessionIdSchema, questions: z.array(questionItemSchema).min(1) }),
  z.object({ type: z.literal("question/resolved"), sessionId: sessionIdSchema, questionRpcId: RPC_ID, outcome: z.enum(["answered", "cancelled"]) }),
  z.object({ type: z.literal("session/queue"), sessionId: sessionIdSchema, items: z.array(queuedItemSchema) }),
  z.object({ type: z.literal("session/jobs"), sessionId: sessionIdSchema, jobs: z.array(taskViewSchema) }),
  z.object({ type: z.literal("session/projection"), sessionId: sessionIdSchema, key: z.string().min(1), value: z.unknown(), seq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("stream/error"), error: dshRpcErrorSchema }),
]);

/** Exact DSH host payload union. */
export const dshHostPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host/session-added"), sessionId: sessionIdSchema, blank: z.boolean(), parentSessionId: sessionIdSchema.optional(), origin: z.literal("subagent").optional(), cwd: z.string().optional(), agentPreset: z.string().optional() }),
  z.object({ type: z.literal("host/session-removed"), sessionId: sessionIdSchema }),
  z.object({ type: z.literal("host/session-status"), sessionId: sessionIdSchema, running: z.boolean() }),
  z.object({ type: z.literal("host/agent-error"), sessionId: sessionIdSchema, message: z.string() }),
  z.object({ type: z.literal("host/workspace-changed"), workspace: workspaceViewSchema }),
  z.object({ type: z.literal("host/workspace-removed"), workspaceId: z.string().min(1) }),
  z.object({ type: z.literal("host/workspace-order-changed"), workspaceIds: z.array(z.string().min(1)) }),
  z.object({ type: z.literal("host/archived-sessions-changed"), archivedSessionIds: z.array(sessionIdSchema) }),
  z.object({ type: z.literal("host/remote-event"), event: z.string().min(1), args: z.array(dshJsonValueSchema) }),
  z.object({ type: z.literal("stream/error"), error: dshRpcErrorSchema }),
]);

export function dshStreamRequestSchema(kind: "mux" | "host") {
  const payload = kind === "mux" ? dshMuxPayloadSchema : dshHostPayloadSchema;
  return z.object({ type: z.literal("server-request"), rpcId: RPC_ID, method: z.string(), payload })
    .refine((frame) => frame.method === frame.payload.type, { message: "method must match payload.type" });
}

/** Outbound Host API methods are dot-qualified domain calls, never URL paths. */
export function isDshApiMethod(value: string): boolean {
  return API_METHOD.safeParse(value).success;
}
