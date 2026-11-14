import { useLayoutEffect, useRef, type MutableRefObject } from "react";
import { appVersion, openExternalLink } from "@/lib/app-links";
import { useStore } from "@/state/store";
import type { AppBlockedReason, AppDocument } from "../../../shared/app";
import { RPC_HOST_REFUSED, type JsonRpcError } from "../../../shared/app-frame/bridge";
import { callAppRpc, newAppSendId, postAppContext, sendAppMessage } from "./app-api";
import { mountAppFrame } from "./app-frame-host";
import { appHostContext, appMaxHeight, appThemeContext } from "./app-host-context";

export interface AppFrameHandle {
  teardown(): Promise<void>;
  /** The frame's element, for a host that speaks to the page beside the bridge (the preview's point mode). */
  iframe?: HTMLIFrameElement;
}

export type AppFrameProblem =
  | { kind: "sign-in"; server: string }
  | { kind: "offline" }
  | { kind: "blocked"; reason: AppBlockedReason; text?: string };

export interface AppFrameProps {
  doc: AppDocument;
  botId: string;
  threadId: string;
  title: string;
  height: number;
  handle: MutableRefObject<AppFrameHandle | null>;
  onHeight(height: number): void;
  onProblem(problem: AppFrameProblem | null): void;
  /** ui/notifications/request-teardown */
  onTeardownRequested(): void;
  /** Fill the container instead of sizing to the page (a page in full screen). */
  fill?: boolean;
  /** The tallest the frame grows to its content, under the window's own limit. */
  maxHeight?: number;
}

const refusal = (message: string): JsonRpcError => ({ code: RPC_HOST_REFUSED, message });

export function AppFrame(props: AppFrameProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const { flushBotPatches } = useStore();
  // Callbacks change every render; the frame lives across renders.
  const latest = useRef({ ...props, flushBotPatches });
  latest.current = { ...props, flushBotPatches };
  const { doc, botId, threadId, fill } = props;

  useLayoutEffect(() => {
    const container = box.current;
    if (!container) return;
    const messageId = doc.messageId;
    const cap = () => Math.min(appMaxHeight(), latest.current.maxHeight ?? Infinity);
    let maxHeight = cap();
    const host = mountAppFrame({
      container,
      doc,
      title: latest.current.title,
      height: latest.current.height,
      hostContext: appHostContext({ width: container.clientWidth || 600, maxHeight }),
      hostVersion: appVersion(),
      ...(import.meta.env?.DEV ? { log: (params: unknown) => console.info("[app]", params) } : {}),
      ...(fill ? { fill: true } : {}),
      adapter: {
        async callRpc(method, params) {
          const outcome = await callAppRpc({ botId, threadId, messageId, method, params });
          if (outcome.ok) return outcome.result;
          if (outcome.signIn) {
            latest.current.onProblem({ kind: "sign-in", server: outcome.signIn.server });
            throw refusal("Sign-in needed");
          }
          if (outcome.blocked) latest.current.onProblem({ kind: "blocked", ...outcome.blocked });
          else if (outcome.status === 0) latest.current.onProblem({ kind: "offline" });
          throw outcome.error;
        },
        async sendMessage(text) {
          // A bot setting just changed is saved before the message starts a turn.
          await latest.current.flushBotPatches(botId);
          await sendAppMessage({ botId, threadId, messageId, text, sendId: newAppSendId() });
        },
        openLink: (url) => openExternalLink(url),
        setContext: (update) => postAppContext({ botId, threadId, messageId, update }),
        resize: (height) => latest.current.onHeight(height),
        teardownRequested: () => latest.current.onTeardownRequested(),
      },
    });
    latest.current.handle.current = { teardown: () => host.teardown(), iframe: host.iframe };

    const skin = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => host.contextChanged(appThemeContext()));
    skin?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    let width = Math.round(container.clientWidth);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      timer = undefined;
      const nextWidth = Math.round(container.clientWidth);
      const nextMax = cap();
      if (nextWidth <= 0 || (nextWidth === width && nextMax === maxHeight)) return;
      width = nextWidth;
      maxHeight = nextMax;
      host.contextChanged({ containerDimensions: { width, maxHeight } });
    };
    const later = () => { if (timer === undefined) timer = setTimeout(measure, 150); };
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    sized?.observe(container);
    window.addEventListener("resize", later);

    return () => {
      skin?.disconnect();
      sized?.disconnect();
      window.removeEventListener("resize", later);
      if (timer !== undefined) clearTimeout(timer);
      if (latest.current.handle.current) latest.current.handle.current = null;
      // The row is going: the frame waits out the View's teardown somewhere hidden.
      host.retire();
    };
    // A new document is a new frame; nothing else remounts it.
  }, [doc, botId, threadId, fill]);

  return <div ref={box} data-app-frame-box className={fill ? "h-full w-full" : "w-full"} />;
}
