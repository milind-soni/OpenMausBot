import { track } from "@/lib/analytics";
import {
  allow, APP, BOT_SOURCE, BOT_TEMPLATE, CALL_MODE, CONNECTOR_RESULT, engineSlug, KEY_PROVIDER, KEY_RESULT, KEY_VIA, ROOM_MODE,
  SIGN_IN_ENGINE, SIGN_IN_METHOD,
  type BotSource, type ConnectorResult, type KeyProvider, type KeyResult, type KeyVia, type SignInMethod,
} from "@/lib/analytics-allowlist";

type Instances = ReadonlyArray<{ instanceId: string; driverKind: string }>;

const CHECKED_BEFORE_SAVE = new Set<string>(["boat", "composio", "elevenlabs", "fish_audio"]);

/** The server saves these keys only after their provider accepted them; every other key is unverified until tested. */
export function savedKeyResult(provider: KeyProvider | "other"): KeyResult {
  return CHECKED_BEFORE_SAVE.has(provider) ? "ok" : "unverified";
}

// Electron 43 rejects ipcRenderer.invoke with "Error invoking remote method '<channel>': " and the toString() of what main threw.
const IPC_KEY_REJECTED = /^Error invoking remote method '[^']*': KeyRejected: /;

export function keySaveFailure(cause: unknown): "rejected" | "error" {
  if ((cause as { body?: { code?: unknown } } | null | undefined)?.body?.code === "key_rejected") return "rejected";
  return cause instanceof Error && IPC_KEY_REJECTED.test(cause.message) ? "rejected" : "error";
}

/** `answer` is what POST /api/keys/test returned, or null when that request failed. */
export function keyTestResult(answer: { ok?: unknown; reason?: unknown } | null | undefined): KeyResult {
  if (answer?.ok === true) return "ok";
  return answer?.reason === "rejected" ? "rejected" : "unverified";
}

export function keySaved(provider: KeyProvider | "other", via: KeyVia, result: KeyResult): void {
  track("api_key_saved", { provider: allow(provider, KEY_PROVIDER), via: allow(via, KEY_VIA), result: allow(result, KEY_RESULT) });
}

export function keyRemoved(provider: KeyProvider | "other", via: KeyVia): void {
  track("api_key_removed", { provider: allow(provider, KEY_PROVIDER), via: allow(via, KEY_VIA) });
}

export function engineSignedIn(engine: string, method: SignInMethod): void {
  track("engine_signed_in", { engine: allow(engine, SIGN_IN_ENGINE), method: allow(method, SIGN_IN_METHOD) });
}

export function botCreated(source: BotSource, template?: string): void {
  track("bot_created", source === "template"
    ? { source, template: allow(template, BOT_TEMPLATE) }
    : { source: allow(source, BOT_SOURCE) });
}

export function connectorConnect(app: string, result: ConnectorResult): void {
  track("connector_connect", { app: allow(app, APP), result: allow(result, CONNECTOR_RESULT) });
}

export function directMessageSent(instances: Instances, instanceId: unknown, queued: boolean): void {
  track("message_sent", { driver: engineSlug(instances, instanceId), queued });
}

export function roomMessageSent(mode: string, queued: boolean): void {
  track("message_sent", { room: true, mode: allow(mode, ROOM_MODE), queued });
}

export function callStarted(instances: Instances, instanceId: unknown, mode: string): void {
  track("call_started", { driver: engineSlug(instances, instanceId), mode: allow(mode, CALL_MODE) });
}
