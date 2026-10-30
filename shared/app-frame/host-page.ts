// The phones' app host page, loaded in a web view: iOS from mausbot-app://host/app-host.html, Android from
// https://appassets.androidplatform.net/app/app-host.html. It holds the same sandboxed srcdoc iframe the
// desktop draws, so the `window.parent.postMessage` contract SDK views assume holds everywhere.
//
// Native ↔ page messages, small and versioned:
//
//   native → page
//     iOS:     evaluateJavaScript / callAsyncJavaScript in the host world,
//              calling `appHost.<fn>(...)` (also `mausbotAppHost.<fn>`)
//     Android: replyProxy.postMessage(JSON.stringify({ v: 1, call, args })),
//              heard on the injected `appHost` object's `onmessage`
//     appHost.load({ v: 1, doc, hostContext, limits?, engagedAt?, hostVersion? })
//     appHost.contextChanged(partialHostContext)
//     appHost.engaged(atMs)            a touch on the web view (epoch ms)
//     appHost.teardown()               resolves after the View answers or 1 s
//     appHost.reply(callId, { result } | { error: { code, message } })
//
//   page → native
//     iOS:     window.webkit.messageHandlers.appHost.postMessage(object)
//     Android: appHost.postMessage(JSON.stringify(object))
//     { v: 1, type: "ready" | "initialized" | "size", height? }
//     { v: 1, type: "call", callId, op: "rpc" | "message" | "open-link" | "context", params }
//     { v: 1, type: "teardown-request" }
//     { v: 1, type: "torn-down" }      teardown finished (for Android, which
//                                      cannot await the call)
//
// `params` per op: rpc {method, params}; message {text};
// open-link {url}; context {content?, structuredContent?}. Native answers
// every call with appHost.reply; a refusal is { error: { code, message } }
// (-32000 for "Offline", "Sign-in needed").
//
// The script holds no secret and needs none: the native side checks that
// every message came from the main frame of this page's origin, and the app
// frame's opaque origin cannot reach this page's globals.
import type { AppDocument } from "../app.ts";
import { APP_FRAME_LIMITS, createAppBridge, type AppBridge, type AppContextUpdate, type AppHostContext, type AppRpcMethod } from "./bridge.ts";

export const APP_HOST_PROTOCOL_VERSION = 1;

export interface AppHostLoad {
  v: 1;
  doc: AppDocument;
  hostContext: AppHostContext;
  /** maxHeight: 70% of the screen; height: the row's initial height
   * (AppPayload.height, or the last one measured for this (messageId, rev)). */
  limits?: { maxHeight?: number; height?: number };
  /** The last touch on the web view, epoch ms. */
  engagedAt?: number;
  /** hostInfo.version: the phone app's version. */
  hostVersion?: string;
}

export type AppHostCallOp = "rpc" | "message" | "open-link" | "context";

export type AppHostToNative =
  | { v: 1; type: "ready" }
  | { v: 1; type: "initialized" }
  | { v: 1; type: "size"; height: number }
  | { v: 1; type: "call"; callId: string; op: AppHostCallOp; params: Record<string, unknown> }
  | { v: 1; type: "teardown-request" }
  | { v: 1; type: "torn-down" };

export type AppHostReply = { result?: unknown } | { error: { code: number; message: string } };

/** Android's native → page message, as JSON over postWebMessage. */
export type AppHostFromNative =
  | { v: 1; call: "load"; args: [AppHostLoad] }
  | { v: 1; call: "contextChanged"; args: [AppHostContext] }
  | { v: 1; call: "engaged"; args: [number] }
  | { v: 1; call: "teardown"; args?: [] }
  | { v: 1; call: "reply"; args: [string, AppHostReply] };

export interface AppHostApi {
  load(input: AppHostLoad): void;
  contextChanged(partial: AppHostContext): void;
  engaged(atMs: number): void;
  teardown(): Promise<void>;
  reply(callId: string, reply: AppHostReply): void;
}

export interface AppHostTransport {
  send(message: AppHostToNative): void;
  /** Android: native's messages arrive here. */
  listen?(handler: (message: AppHostFromNative) => void): void;
}

interface AndroidInjected {
  postMessage(message: string): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
}

export function findAppHostTransport(win: Window): AppHostTransport | null {
  const webkit = (win as unknown as { webkit?: { messageHandlers?: { appHost?: { postMessage(message: unknown): void } } } }).webkit;
  const ios = webkit?.messageHandlers?.appHost;
  if (ios && typeof ios.postMessage === "function") return { send: (message) => ios.postMessage(message) };
  const android = (win as unknown as { appHost?: AndroidInjected }).appHost;
  if (android && typeof android.postMessage === "function") {
    return {
      send: (message) => android.postMessage(JSON.stringify(message)),
      listen: (handler) => {
        android.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          let parsed: unknown;
          try { parsed = JSON.parse(event.data); } catch { return; }
          if (parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === APP_HOST_PROTOCOL_VERSION) handler(parsed as AppHostFromNative);
        };
      },
    };
  }
  return null;
}

export function startAppHostPage(win: Window, given?: AppHostTransport): AppHostApi | null {
  const transport = given ?? findAppHostTransport(win);
  if (!transport) return null;
  const doc = win.document;
  let bridge: AppBridge | null = null;
  let frame: HTMLIFrameElement | null = null;
  let engagedAt = 0;
  let reportedInitialized = false;
  let seq = 0;
  const calls = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  const send = (message: AppHostToNative) => { try { transport.send(message); } catch { /* native went away */ } };

  const call = (op: AppHostCallOp, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const callId = `c${++seq}`;
    calls.set(callId, { resolve, reject });
    send({ v: 1, type: "call", callId, op, params });
  });

  const failAll = () => {
    for (const waiting of calls.values()) waiting.reject({ code: -32000, message: "This app was closed." });
    calls.clear();
  };

  win.addEventListener("message", (event: MessageEvent) => {
    if (!bridge) return;
    bridge.handleMessage({ source: event.source, data: event.data });
    if (!reportedInitialized && bridge.initialized) {
      reportedInitialized = true;
      send({ v: 1, type: "initialized" });
    }
  });

  const unmount = () => {
    bridge?.dispose();
    bridge = null;
    frame?.remove();
    frame = null;
    reportedInitialized = false;
    failAll();
  };

  const api: AppHostApi = {
    load(input) {
      if (!input || input.v !== APP_HOST_PROTOCOL_VERSION || !input.doc || typeof input.doc.srcdoc !== "string") return;
      unmount();
      if (typeof input.engagedAt === "number") engagedAt = input.engagedAt;
      const element = doc.createElement("iframe");
      // Exactly these two sandbox tokens, and no `allow` attribute.
      element.setAttribute("sandbox", "allow-scripts allow-forms");
      element.setAttribute("referrerpolicy", "no-referrer");
      element.setAttribute("title", "App");
      const height = Math.max(APP_FRAME_LIMITS.minHeight, Math.round(input.limits?.height ?? APP_FRAME_LIMITS.defaultHeight));
      element.style.height = `${height}px`;
      const current = createAppBridge({
        doc: input.doc,
        hostContext: input.hostContext ?? {},
        hostVersion: input.hostVersion ?? "phone",
        ...(input.limits?.maxHeight ? { limits: { maxHeight: input.limits.maxHeight } } : {}),
        source: () => element.contentWindow,
        adapter: {
          post: (message) => element.contentWindow?.postMessage(message, "*"),
          callRpc: (method: AppRpcMethod, params) => call("rpc", { method, params }),
          sendMessage: async (text) => { await call("message", { text }); },
          openLink: async (url) => { await call("open-link", { url }); },
          setContext: async (update: AppContextUpdate) => { await call("context", { ...update }); },
          resize: (next) => {
            element.style.height = `${next}px`;
            send({ v: 1, type: "size", height: next });
          },
          engaged: () => Date.now() - engagedAt <= APP_FRAME_LIMITS.engagedTouchMs,
          teardownRequested: () => send({ v: 1, type: "teardown-request" }),
          now: () => Date.now(),
        },
      });
      bridge = current;
      frame = element;
      // The bridge exists before the frame can speak: it loads on insertion.
      element.srcdoc = input.doc.srcdoc;
      doc.body.appendChild(element);
    },
    contextChanged(partial) {
      bridge?.contextChanged(partial ?? {});
    },
    engaged(atMs) {
      if (typeof atMs === "number" && Number.isFinite(atMs)) engagedAt = Math.max(engagedAt, atMs);
    },
    async teardown() {
      if (bridge) await bridge.teardown();
      unmount();
      send({ v: 1, type: "torn-down" });
    },
    reply(callId, reply) {
      const waiting = calls.get(callId);
      if (!waiting) return;
      calls.delete(callId);
      if (reply && "error" in reply && reply.error) waiting.reject(reply.error);
      else waiting.resolve(reply && "result" in reply ? reply.result : undefined);
    },
  };

  transport.listen?.((message) => {
    switch (message.call) {
      case "load": return api.load(message.args[0]);
      case "contextChanged": return api.contextChanged(message.args[0]);
      case "engaged": return api.engaged(message.args[0]);
      case "teardown": return void api.teardown();
      case "reply": return api.reply(message.args[0], message.args[1]);
    }
  });
  const globals = win as unknown as { appHost?: unknown; mausbotAppHost?: unknown };
  // Android's injected object owns the name `appHost` there; native reaches
  // the page through it, so it is left alone.
  if (!(globals.appHost && typeof (globals.appHost as AndroidInjected).postMessage === "function")) globals.appHost = api;
  globals.mausbotAppHost = api;
  send({ v: 1, type: "ready" });
  return api;
}

/** On iOS the copy that runs in the page world finds no handler (it lives in the host content world) and
 * stays idle. */
export function bootAppHostPage(): void {
  if (typeof window !== "undefined") startAppHostPage(window);
}
