import { z } from "zod";

const RPC_ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const METHOD = z.string().min(1).max(160).regex(/^[A-Za-z][A-Za-z0-9._/-]*$/);
const API_METHOD = z.string().min(3).max(160).regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/);
const ERROR_CODE = z.string().min(1).max(96).regex(/^[a-z][a-z0-9-]*$/);
const ERROR_MESSAGE = z.string().min(1).max(500);
export const dshJsonValueSchema = z.json();
export type DshJsonValue = z.infer<typeof dshJsonValueSchema>;

export const dshRpcResultSchema = z.union([
  z.object({ ok: z.literal(true), value: dshJsonValueSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: ERROR_CODE, message: ERROR_MESSAGE, details: dshJsonValueSchema.optional() }) }),
]);
export type DshRpcResult = z.infer<typeof dshRpcResultSchema>;

export const dshClientRequestSchema = z.object({
  type: z.literal("client-request"),
  rpcId: RPC_ID,
  method: METHOD,
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
  method: METHOD,
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

export function isDshMethod(value: string): boolean {
  return METHOD.safeParse(value).success;
}

/** Outbound Host API methods are dot-qualified domain calls, never URL paths. */
export function isDshApiMethod(value: string): boolean {
  return API_METHOD.safeParse(value).success;
}
