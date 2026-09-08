import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, RotateCcw } from "lucide-react";
import runtime from "virtual:interactive-runtime";
import frameCss from "../interactive/runtime.css?inline";
import { validateInteractiveSource } from "../../shared/interactive-reply";
import { boundedInteractiveState, interactiveStateKey, readInteractiveState } from "@/lib/interactive-state";
import { appendComposerDraftText } from "@/lib/drafts";
import type { MessageAttachmentContext } from "./AttachmentPreview";
import { t } from "@/lib/i18n";
import "./interactive-reply.css";

const FollowUpContext = createContext<((thread: string, text: string) => void) | null>(null);
/** Permit blocks in this task to append plain text to its unsent composer only. */
export function InteractiveReplyScope({ scope, children }: { scope: string; children: ReactNode }) {
  const draft = useCallback(
    (thread: string, text: string) => {
      if (scope.endsWith(`:${thread}`)) appendComposerDraftText(scope, text);
    },
    [scope],
  );
  return <FollowUpContext.Provider value={draft}>{children}</FollowUpContext.Provider>;
}

const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'"><style>${frameCss}</style></head><body><div id="root"></div><script>${runtime.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;

/** Snapshot the host's approved theme tokens for the isolated frame. */
function currentTheme() {
  const style = getComputedStyle(document.documentElement);
  return {
    ...Object.fromEntries(
      Object.entries({
        ink: "ink",
        muted: "ink-secondary",
        surface: "inset",
        border: "hairline",
        accent: "accent",
        canvas: "card",
      }).map(([key, value]) => [key, style.getPropertyValue(`--color-${value}`).trim()]),
    ),
    scheme: style.getPropertyValue("--code-color-scheme").trim(),
    font: getComputedStyle(document.body).fontFamily,
  };
}

/** Admit a fenced reply and key its view to the message/source identity. */
export function InteractiveReply({
  source,
  streaming,
  message,
  offset,
}: {
  source: string;
  streaming: boolean;
  message?: MessageAttachmentContext;
  offset: number;
}) {
  const error = useMemo(() => validateInteractiveSource(source), [source]);
  const key = message ? interactiveStateKey(message.threadId, message.messageId, offset, source) : source;
  return (
    <InteractiveView
      key={key}
      source={source}
      streaming={streaming}
      initialError={error}
      stateKey={message ? key : undefined}
      message={message}
    />
  );
}

/** Own the nonce-bound sandbox handshake, local state and source fallback.
 * Outward drafts append to the composer and never submit a turn. */
function InteractiveView({
  source,
  streaming,
  initialError,
  stateKey,
  message,
}: {
  source: string;
  streaming: boolean;
  initialError: string | null;
  stateKey?: string;
  message?: MessageAttachmentContext;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(180);
  const [error, setError] = useState(initialError);
  const [ready, setReady] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [drafted, setDrafted] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const draft = useContext(FollowUpContext);
  const messageThread = message?.threadId;
  const token = useMemo(() => crypto.randomUUID(), [revision]);
  const init = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      {
        channel: "omb-interactive-v1",
        token,
        type: "init",
        value: {
          source,
          initialState: readInteractiveState(stateKey),
          theme: currentTheme(),
          labels: {
            draft: t("interactive.ask"),
            drafted: t("interactive.drafted"),
            table: t("interactive.table"),
          },
        },
      },
      "*",
    );
  }, [source, stateKey, token]);
  useLayoutEffect(() => {
    if (streaming || initialError || collapsed) return;
    // Loading a srcdoc and attaching its host listener are independent. Retry
    // the nonce-bound handshake until acknowledged; the child treats repeated
    // init messages as acknowledgements and never resets an existing form.
    const handshake = setInterval(init, 250);
    const timer = setTimeout(() => {
      clearInterval(handshake);
      setError(t("interactive.timeout"));
    }, 15_000);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== "omb-interactive-v1")
        return;
      if (event.data.type === "boot") {
        init();
        return;
      }
      if (event.data.token !== token) return;
      const { type, value } = event.data;
      if (type === "ready") {
        clearTimeout(timer);
        clearInterval(handshake);
        setReady(true);
      }
      if (type === "height" && typeof value === "number" && Number.isFinite(value))
        setHeight(Math.max(80, Math.min(1600, value + 2)));
      if (type === "error") {
        clearTimeout(timer);
        clearInterval(handshake);
        setError(t("interactive.failed"));
      }
      if (type === "state" && stateKey) {
        const state = boundedInteractiveState(value);
        if (state)
          try {
            localStorage.setItem(stateKey, JSON.stringify(state));
          } catch {
            /* Message data is durable even without local preference storage. */
          }
      }
      // The only outward action adds plain text to the existing composer. It
      // cannot send, change tasks, attach paths, call tools or navigate URLs.
      if (
        type === "draft" &&
        typeof value === "string" &&
        value.trim() &&
        value.length <= 4000 &&
        messageThread &&
        draft
      ) {
        draft(messageThread, value);
        setDrafted(true);
      }
    };
    addEventListener("message", receive);
    init();
    const observer = new MutationObserver(() =>
      frame.current?.contentWindow?.postMessage(
        { channel: "omb-interactive-v1", token, type: "theme", value: currentTheme() },
        "*",
      ),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-skin", "style", "class"],
    });
    return () => {
      clearTimeout(timer);
      clearInterval(handshake);
      removeEventListener("message", receive);
      observer.disconnect();
    };
  }, [streaming, initialError, collapsed, token, init, stateKey, messageThread, draft]);
  return (
    <section className="interactive-reply" aria-label={t("interactive.label")}>
      <header>
        <details className="interactive-menu">
          <summary aria-label={t("interactive.options")} title={t("interactive.options")}>
            <MoreHorizontal size={17} />
          </summary>
          <div>
            <button
              type="button"
              onClick={() => {
                if (stateKey)
                  try {
                    localStorage.removeItem(stateKey);
                  } catch {}
                setError(initialError);
                setReady(false);
                setDrafted(false);
                setRevision((n) => n + 1);
              }}
            >
              <RotateCcw size={13} />
              {t("interactive.reset")}
            </button>
            <button type="button" onClick={() => setShowSource((value) => !value)}>
              {t("interactive.source")}
            </button>
            <p>{t("interactive.local")}</p>
          </div>
        </details>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("interactive.expand") : t("interactive.collapse")}
          onClick={() => {
            setCollapsed(!collapsed);
            setReady(false);
          }}
        >
          {collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
        </button>
      </header>
      {collapsed && <p>{t("interactive.label")}</p>}
      {!collapsed && (
        <>
          {(streaming || (!ready && !error)) && <p role="status">{t("interactive.preparing")}</p>}
          {!streaming && error && <p role="status">{error}</p>}
          {!streaming && !error && (
            <iframe
              key={revision}
              ref={frame}
              title={t("interactive.label")}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
              onLoad={init}
              style={{ height }}
            />
          )}
          {drafted && (
            <p className="interactive-drafted" role="status">
              {t("interactive.drafted")}
            </p>
          )}
          {(showSource || error) && (
            <footer>
              <details open={showSource}>
                <summary>{t("interactive.source")}</summary>
                <pre>{source}</pre>
              </details>
            </footer>
          )}
        </>
      )}
    </section>
  );
}
