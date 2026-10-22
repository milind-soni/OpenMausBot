import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CircleAlert, X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { openExternalLink } from "@/lib/app-links";
import { useShowThreads } from "@/lib/thread-preferences";
import { resolvedThreadTarget } from "@/lib/thread-target";
import { openThread } from "@/state/thread-navigation";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  widgetActions, widgetFields, widgetInitialValues, widgetScope, widgetString, type WidgetField, type WidgetNode, type WidgetOther, type WidgetPayload,
  type WidgetSettled, type WidgetValues,
} from "../../../shared/widget";
import { ASK_QUIET_BUTTON, AskSettledLine, returnFocusToComposer } from "../AskCard";
import { WidgetBody } from "./WidgetBody";
import { WIDGET_COMPACT_BELOW, widgetActionUrl, widgetThreadTarget, WidgetButton, WidgetFormProvider, WidgetGlyph, type WidgetForm } from "./WidgetControls";
import { kids } from "./widget-style";
import { newWidgetSendId, sendWidgetAction, type WidgetSendResult } from "./widget-send";

const WIDTH: Record<string, string> = { sm: "max-w-[360px]", md: "max-w-[440px]", lg: "max-w-[600px]", full: "max-w-[600px]" };
const SURFACE = "w-full overflow-hidden rounded-3xl bg-composer ring-1 ring-composer-ring transition-opacity";
const SENT_MS = 1600;

function labelledFields(node: WidgetNode, into = new Set<string>()): Set<string> {
  if (node.type === "Label" && typeof node.fieldName === "string") into.add(node.fieldName);
  for (const child of kids(node)) labelledFields(child, into);
  return into;
}

function isEmpty(field: WidgetField, values: WidgetValues, other: WidgetOther): boolean {
  if (Object.hasOwn(other, field.name)) return !other[field.name]!.trim();
  const value = values[field.name];
  return field.type === "Checkbox" ? value !== true : typeof value !== "string" || !value.trim();
}

export function WidgetMessage({ botId, threadId, message }: { botId: string; threadId?: string; message: Message }) {
  const payload = message.widget;
  if (!payload?.root || typeof payload.root !== "object" || typeof payload.root.type !== "string") {
    return message.text
      ? <div className="chat-text w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">{message.text}</div>
      : null;
  }
  // update_widget renumbers node ids, so a new revision remounts the card.
  return <WidgetCard key={payload.rev ?? 0} botId={botId} threadId={threadId} messageId={message.id} payload={payload} />;
}

function WidgetCard({ botId, threadId, messageId, payload }: { botId: string; threadId?: string; messageId: string; payload: WidgetPayload }) {
  const root = payload.root;
  const { state, dispatch, flushBotPatches } = useStore();
  const showThreads = useShowThreads();
  const [settledHere, setSettledHere] = useState<WidgetSettled>();
  /**
   * Once the row has spoken since this card's last press, only the row decides, whichever of the patch frame and the
   * POST answer lands first.
   */
  const [rowSpoke, setRowSpoke] = useState(false);
  if (payload.settled !== undefined && !rowSpoke) setRowSpoke(true);
  const settled = payload.settled ?? (rowSpoke ? undefined : settledHere);
  const isSettled = settled !== undefined;
  const uid = useId();
  const frame = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const watch = useCallback((element: HTMLDivElement | null) => {
    frame.current = element;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setCompact(width < WIDGET_COMPACT_BELOW);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [edits, setEdits] = useState<WidgetValues>({});
  const [otherEdits, setOtherEdits] = useState<WidgetOther>({});
  const [pending, setPending] = useState<string>();
  const [sent, setSent] = useState<string>();
  const [problem, setProblem] = useState<{ text: string; field?: string }>();
  const [details, setDetails] = useState(false);
  const [imagesAllowed, setImagesAllowed] = useState(false);
  /** A press that got no answer goes again under the same sendId, so the server counts it once. */
  const retry = useRef<{ key: string; sendId: string }>(undefined);
  const answering = useRef(false);
  /** Set as the send starts, not on the next render: two presses in one tick are one press. */
  const sendingNow = useRef(false);
  const mounted = useRef(true);
  const sentTimer = useRef<number>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(sentTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!isSettled) return;
    setPending(undefined);
    if (!answering.current) return;
    answering.current = false;
    returnFocusToComposer();
  }, [isSettled]);

  const actions = useMemo(() => new Map(widgetActions(root).map((entry) => [entry.ref, entry])), [root]);
  const fields = useMemo(() => new Map(widgetFields(root).map((field) => [field.name, field])), [root]);
  const labelled = useMemo(() => labelledFields(root), [root]);
  const values = useMemo(() => ({ ...widgetInitialValues(root), ...edits, ...settled?.values }), [root, edits, settled]);
  const other = settled ? settled.other ?? {} : otherEdits;

  const press = (ref: string) => {
    const entry = actions.get(ref);
    if (!entry || sendingNow.current || pending !== undefined) return;
    if (entry.client) {
      const url = widgetActionUrl(entry);
      if (url) void openExternalLink(url);
      const target = resolvedThreadTarget(widgetThreadTarget(entry), state);
      if (target) openThread(dispatch, target, state, showThreads);
      return;
    }
    if (settled) return;
    let sending: WidgetValues | undefined;
    let sendingOther: WidgetOther | undefined;
    if (entry.tone !== "cancel") {
      const scope = widgetFields(widgetScope(root, ref), root);
      const empty = entry.tone ? scope.find((field) => field.node.required === true && isEmpty(field, values, other)) : undefined;
      if (empty) {
        setProblem({ text: t("widget.required", { label: empty.label }), field: empty.name });
        const where = Object.hasOwn(other, empty.name) ? "data-widget-other" : "data-widget-field";
        frame.current?.querySelector<HTMLElement>(`[${where}="${empty.name}"]`)?.focus();
        return;
      }
      const typed = scope.filter((field) => Object.hasOwn(other, field.name) && other[field.name]!.trim());
      sending = Object.fromEntries(scope.map((field) => [field.name, Object.hasOwn(other, field.name) ? "" : values[field.name] ?? (field.type === "Checkbox" ? false : "")]));
      if (typed.length) sendingOther = Object.fromEntries(typed.map((field) => [field.name, other[field.name]!]));
    }
    const key = `${ref}\n${JSON.stringify(sending ?? null)}\n${JSON.stringify(sendingOther ?? null)}`;
    const sendId = retry.current?.key === key ? retry.current.sendId : newWidgetSendId();
    retry.current = { key, sendId };
    sendingNow.current = true;
    answering.current = entry.tone !== undefined;
    setRowSpoke(false);
    setSettledHere(undefined);
    setProblem(undefined);
    setSent(undefined);
    setPending(ref);
    // Pending bot settings save before the press starts a turn; if that save fails, nothing is posted.
    const saved: Promise<unknown> = Promise.resolve().then(() => flushBotPatches(botId));
    const unsaved = (): WidgetSendResult => ({ ok: false, refused: false });
    void saved.then(() => sendWidgetAction({ botId, threadId, messageId, ref, rev: payload.rev ?? 0, values: sending, other: sendingOther, sendId }), unsaved).then((result) => {
      sendingNow.current = false;
      if (!mounted.current) return;
      if (!result.ok) {
        if (result.refused) retry.current = undefined;
        answering.current = false;
        setPending(undefined);
        setProblem({ text: result.error ?? t("widget.sendFailed") });
        return;
      }
      retry.current = undefined;
      if (entry.tone) {
        setSettledHere({ ref, label: entry.label, tone: entry.tone, at: Date.now(), sendId, ...(sending ? { values: sending } : {}), ...(sendingOther ? { other: sendingOther } : {}) });
        return;
      }
      setPending(undefined);
      setSent(ref);
      window.clearTimeout(sentTimer.current);
      sentTimer.current = window.setTimeout(() => mounted.current && setSent(undefined), SENT_MS);
    });
  };

  const errorId = `${uid}-problem`;
  const title = widgetString(root, "title");
  const caption = widgetString(root, "caption");
  const meta = widgetString(root, "meta");
  const status = root.status && typeof root.status === "object" ? root.status as { text?: unknown; icon?: unknown } : {};
  const statusText = typeof status.text === "string" ? status.text : undefined;
  const headed = Boolean(title || caption || meta || statusText);
  const name = title ?? statusText ?? t("widget.aria.card");
  const form: WidgetForm = {
    uid,
    values,
    setValue: (name, value) => {
      setEdits((current) => ({ ...current, [name]: value }));
      setOtherEdits(({ [name]: _dropped, ...rest }) => rest);
      if (problem?.field === name) setProblem(undefined);
    },
    other,
    chooseOther: (name) => {
      setEdits((current) => ({ ...current, [name]: "" }));
      setOtherEdits((current) => ({ ...current, [name]: current[name] ?? "" }));
      if (problem?.field === name) setProblem(undefined);
    },
    setOther: (name, text) => {
      setOtherEdits((current) => ({ ...current, [name]: text }));
      if (problem?.field === name) setProblem(undefined);
    },
    locked: isSettled || pending !== undefined,
    invalid: problem?.field,
    errorId,
    fields,
    actions,
    pendingRef: pending,
    sentRef: sent,
    press,
    imagesAllowed,
    allowImages: () => setImagesAllowed(true),
    labelled,
    compact,
    name: title ?? statusText ?? "",
  };
  const confirm = actions.get("confirm");
  const cancel = actions.get("cancel");

  const card = (
    <WidgetFormProvider value={form}>
      <div
        ref={watch}
        role="group"
        aria-label={name}
        aria-busy={pending !== undefined || undefined}
        data-widget={messageId}
        data-widget-state={settled ? "settled" : pending !== undefined ? "sending" : "live"}
        data-widget-compact={compact || undefined}
        className={cn("w-full text-start", WIDTH[widgetString(root, "size") ?? "lg"] ?? WIDTH.lg)}
      >
        <div className={cn(SURFACE, pending !== undefined && "opacity-[0.55]")}>
          {headed && (
            <div className={cn("flex items-start gap-3 px-4 pt-3.5", kids(root).length ? "pb-3" : "pb-3.5")}>
              <div className="min-w-0 flex-1">
                {statusText && (
                  <p className={cn("flex items-center gap-1.5 text-[12.5px] font-semibold leading-[18px] text-accent-text", (title || caption) && "mb-1")}>
                    {typeof status.icon === "string" && <WidgetGlyph name={status.icon} size={14} />}
                    <bdi dir="auto" className="min-w-0 truncate">{statusText}</bdi>
                  </p>
                )}
                {title && <div title={title} className="truncate text-[15px] font-semibold leading-6 text-ink"><bdi dir="auto">{title}</bdi></div>}
                {caption && <div dir="auto" className="mt-0.5 text-[13px] leading-snug text-ink-secondary">{caption}</div>}
              </div>
              {meta && <span dir="auto" className="mt-1 shrink-0 whitespace-nowrap text-[12px] leading-4 tabular-nums text-ink-tertiary">{meta}</span>}
            </div>
          )}
          <WidgetBody root={root} headed={headed} />
          {problem && (
            <div id={errorId} role="alert" className="mx-4 flex items-start gap-2 border-t border-ink/[0.12] pb-3.5 pt-3 text-[13px] leading-[18px] text-danger">
              <CircleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
              <span dir="auto" className="min-w-0 break-words">{problem.text}</span>
            </div>
          )}
        </div>
        {!settled && (confirm || cancel) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {confirm && <WidgetButton actionRef="confirm" label={confirm.label} look="primary" />}
            {cancel && <WidgetButton actionRef="cancel" label={cancel.label} look="outline" />}
          </div>
        )}
        <span role="status" className="sr-only">{pending !== undefined ? t("widget.sending") : sent !== undefined ? t("widget.sent") : ""}</span>
      </div>
    </WidgetFormProvider>
  );

  if (!settled) return card;
  const detailsId = `${uid}-details`;
  return (
    <AskSettledLine
      ariaLabel={name}
      icon={settled.tone === "cancel" ? <X size={13} /> : undefined}
      action={(
        <button type="button" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails((open) => !open)} className={ASK_QUIET_BUTTON}>
          {details ? t("question.hideDetails") : t("question.details")}
        </button>
      )}
      detail={details && <div id={detailsId} className="mt-2">{card}</div>}
    >
      <span dir="auto">{settled.label}</span>
    </AskSettledLine>
  );
}
