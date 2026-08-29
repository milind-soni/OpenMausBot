/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type,
 * anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread,
 * anti-slop/no-known-value-widening
 * -- the SSE stream is an untrusted external JSON boundary; parsePushEvent
 * validates the frame before any notification is dispatched. */
import type { FcmSendResult, PushNotification } from "./fcm.ts";
import type { PushTarget } from "./devices.ts";

const NOTIFY_KINDS = ["approval", "question", "done", "routine-failed", "takeover"] as const;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;

const boundedString = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max ? value : null;

const isNotifyKind = (value: string): value is PushNotification["kind"] =>
  NOTIFY_KINDS.some((candidate) => candidate === value);

export function parsePushEvent(sseId: string, frame: unknown): PushNotification | null {
  const outer = record(frame);
  const source = outer && record(outer.notification);
  if (!outer || outer.kind !== "notify" || !source) return null;
  const id = boundedString(sseId, 200);
  const kind = boundedString(source.kind, 40);
  const botId = boundedString(source.botId, 200);
  const botName = boundedString(source.botName, 200);
  const threadId = boundedString(source.threadId, 200);
  const title = boundedString(source.title, 240);
  const body = boundedString(source.body, 2_000);
  const avatarUrl = source.avatarUrl === undefined ? undefined : boundedString(source.avatarUrl, 2_048);
  if (!id || !kind || !isNotifyKind(kind)) return null;
  if (!botId || !botName || !threadId || !title || !body || avatarUrl === null) return null;
  return {
    id,
    kind,
    botId,
    botName,
    threadId,
    title,
    body,
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

interface DispatchOptions {
  notification: PushNotification;
  targets: PushTarget[];
  send: (token: string, notification: PushNotification) => Promise<FcmSendResult>;
  clear: (deviceId: string) => boolean;
}

export async function dispatchPushNotification(options: DispatchOptions): Promise<void> {
  await Promise.all(
    options.targets.map(async (target) => {
      const result = await options.send(target.token, options.notification);
      if (result.kind === "invalid-target") options.clear(target.deviceId);
    }),
  );
}

interface PushBridgeOptions {
  harnessPort: number;
  targets: () => PushTarget[];
  send: DispatchOptions["send"];
  clear: DispatchOptions["clear"];
  fetch?: typeof globalThis.fetch;
  reconnectMs?: number;
  log?: (message: string) => void;
}

/** Keep one private event subscription alive inside the desktop sidecar.
 * The phone app can be fully closed; this process receives notifications and
 * hands them to FCM. SSE ids become stable mobile dedupe ids, and reconnects
 * resume from the last completely parsed event. */
export function startPushBridge(options: PushBridgeOptions): () => void {
  const request = options.fetch ?? globalThis.fetch;
  const reconnectMs = options.reconnectMs ?? 2_000;
  let stopped = false;
  let controller: AbortController | null = null;
  let cursor = "";
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const retry = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, reconnectMs);
    retryTimer.unref?.();
  };

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const response = await request(`http://127.0.0.1:${options.harnessPort}/api/events?screens=off`, {
        headers: {
          accept: "text/event-stream",
          ...(cursor ? { "last-event-id": cursor } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`event stream returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const lines = block.split("\n");
          const idLine = lines.find((line) => line.startsWith("id: "));
          const dataLine = lines.find((line) => line.startsWith("data: "));
          const eventId = idLine?.slice(4).trim() ?? "";
          if (eventId && dataLine) {
            let frame: unknown;
            try {
              frame = JSON.parse(dataLine.slice(6));
            } catch {
              frame = null;
            }
            const notification = parsePushEvent(eventId, frame);
            if (notification) {
              await dispatchPushNotification({
                notification,
                targets: options.targets(),
                send: options.send,
                clear: options.clear,
              });
            }
            cursor = eventId;
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!stopped) options.log?.(error instanceof Error ? error.message : "push bridge disconnected");
    } finally {
      controller = null;
      retry();
    }
  };

  void connect();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    controller?.abort();
  };
}
