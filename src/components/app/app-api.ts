import { api, ApiError } from "@/state/store";
import type { AppBlockedReason, AppDocument } from "../../../shared/app";
import type { PublishedPageCard } from "../../../shared/published-page";
import { RPC_HOST_REFUSED, type AppContextUpdate, type AppRpcMethod, type JsonRpcError } from "../../../shared/app-frame/bridge";

export function appDocumentPath(threadId: string, messageId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/app`;
}

function appActionPath(botId: string, messageId: string, action: "rpc" | "context"): string {
  return `/api/bots/${encodeURIComponent(botId)}/apps/${encodeURIComponent(messageId)}/${action}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type AppFetchFailure = { offline: true } | { offline: false; status: number; error: string };

export class AppDocumentError extends Error {
  readonly failure: AppFetchFailure;
  constructor(failure: AppFetchFailure) {
    super(failure.offline ? "offline" : failure.error);
    this.name = "AppDocumentError";
    this.failure = failure;
  }
}

function failureOf(error: unknown): AppFetchFailure {
  if (error instanceof ApiError) return { offline: false, status: error.status, error: error.message };
  return { offline: true };
}

/** `rev`: an earlier version of a bot's page; the current one when omitted. A folder page's files load from this
 * window's own origin, which is where /api answers. */
export async function fetchAppDocument(threadId: string, messageId: string, signal?: AbortSignal, rev?: number): Promise<AppDocument> {
  const query = new URLSearchParams({ origin: window.location.origin, ...(rev === undefined ? {} : { rev: String(rev) }) });
  try {
    const doc = await api<AppDocument>(`${appDocumentPath(threadId, messageId)}?${query}`, { signal });
    if (!isRecord(doc) || typeof doc.srcdoc !== "string" || !isRecord(doc.can)) throw new AppDocumentError({ offline: false, status: 500, error: "The app's page did not arrive whole." });
    return doc;
  } catch (error) {
    if (error instanceof AppDocumentError) throw error;
    if (signal?.aborted) throw error;
    throw new AppDocumentError(failureOf(error));
  }
}

export interface AppRpcRefusal {
  status: number;
  error: JsonRpcError;
  /** 401: the person must sign in to this server again. */
  signIn?: { server: string };
  /** 410: the server is gone, off, or its apps are switched off. */
  blocked?: { reason: AppBlockedReason; text?: string };
}

export type AppRpcOutcome = { ok: true; result: unknown } | ({ ok: false } & AppRpcRefusal);

export const OFFLINE_ERROR: JsonRpcError = { code: RPC_HOST_REFUSED, message: "Offline" };

function rpcRefusal(error: unknown): AppRpcRefusal {
  if (!(error instanceof ApiError)) return { status: 0, error: OFFLINE_ERROR };
  const body = isRecord(error.body) ? error.body : {};
  const given = isRecord(body.error) ? body.error : null;
  const code = given && typeof given.code === "number" && Number.isInteger(given.code) ? given.code : RPC_HOST_REFUSED;
  const refusal: AppRpcRefusal = { status: error.status, error: { code, message: error.message || "The app's server refused this." } };
  if (isRecord(body.signIn) && typeof body.signIn.server === "string") refusal.signIn = { server: body.signIn.server };
  if (isRecord(body.blocked) && typeof body.blocked.reason === "string") {
    refusal.blocked = { reason: body.blocked.reason as AppBlockedReason, ...(typeof body.blocked.text === "string" ? { text: body.blocked.text } : {}) };
  } else if (error.status === 410) {
    refusal.blocked = { reason: "server-removed" };
  }
  return refusal;
}

export async function callAppRpc(args: {
  botId: string;
  threadId: string;
  messageId: string;
  method: AppRpcMethod;
  params: Record<string, unknown>;
}): Promise<AppRpcOutcome> {
  try {
    const result = await api<unknown>(appActionPath(args.botId, args.messageId, "rpc"), {
      method: "POST",
      body: JSON.stringify({ threadId: args.threadId, method: args.method, params: args.params }),
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, ...rpcRefusal(error) };
  }
}

export async function postAppContext(args: { botId: string; threadId: string; messageId: string; update: AppContextUpdate }): Promise<void> {
  await api(appActionPath(args.botId, args.messageId, "context"), {
    method: "POST",
    body: JSON.stringify({ threadId: args.threadId, ...args.update }),
  });
}

export const newAppSendId = (): string => crypto.randomUUID();

/** Rejects with the server's sentence, or "Offline". */
export async function sendAppMessage(args: { botId: string; threadId: string; messageId: string; text: string; sendId: string }): Promise<void> {
  try {
    await api(`/api/bots/${encodeURIComponent(args.botId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ threadId: args.threadId, sendId: args.sendId, appMessage: { messageId: args.messageId, text: args.text } }),
    });
  } catch (error) {
    throw error instanceof ApiError ? new Error(error.message) : new Error(OFFLINE_ERROR.message);
  }
}

export type PagePublishOutcome = { ok: true; card: PublishedPageCard } | { ok: false; error: string; card?: PublishedPageCard };

/** Publishes the version on screen to a public link, the same link every time. */
export async function publishAppPage(threadId: string, messageId: string, rev: number): Promise<PagePublishOutcome> {
  try {
    const body = await api<{ card: PublishedPageCard }>(`${appDocumentPath(threadId, messageId)}/publish`, { method: "POST", body: JSON.stringify({ rev }) });
    return { ok: true, card: body.card };
  } catch (error) {
    if (!(error instanceof ApiError)) return { ok: false, error: OFFLINE_ERROR.message };
    const card = isRecord(error.body) && isRecord(error.body.card) ? error.body.card as unknown as PublishedPageCard : undefined;
    return { ok: false, error: error.message, ...(card ? { card } : {}) };
  }
}

/** Takes a published page down; its card says so once the server has patched it. */
export async function unpublishPage(pageId: string): Promise<boolean> {
  try {
    await api(`/api/published-pages/${encodeURIComponent(pageId)}/unpublish`, { method: "POST", body: "{}" });
    return true;
  } catch {
    return false;
  }
}
