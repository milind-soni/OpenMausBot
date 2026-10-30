// The one-time move to My Cloud in the account area at the bottom of the sidebar, never as a strip over the page: a
// short segment in the account's name, a line by the account (above it in Simple, under the name in Advanced), a dot
// on the avatar, and the move's own row at the top of the account menu. In the desktop app only, never in a browser.
import { useSyncExternalStore } from "react";
import { CloudAlert, CloudCheck, CloudUpload, Loader2, RefreshCw, Smartphone, X } from "lucide-react";
import type { CloudSendPageBridge } from "../../electron/cloud-send.mjs";
import { MOVE_LINE } from "../../electron/cloud-send-parts.mjs";
import { ipcErrorText, moveLine } from "@/lib/cloud-send";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useCloudSendNotice } from "./CloudSendStrip";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

export type AccountMoveLine = NonNullable<ReturnType<typeof moveLine>>;
export type AccountMoveKind = AccountMoveLine["kind"];

const pageBridge = () => (!window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined);

/** The account's words for the move: it needs the person once it has failed for a day, goes quietly meanwhile, and
 * says nothing once done (its menu row says what arrived). */
export function accountMoveWords(kind: AccountMoveKind | null): string | null {
  if (kind === "failed") return t("sidebar.account.moveNeedsYou");
  if (kind === "sending") return t("sidebar.account.moving");
  return null;
}

/** Why a failing move failed: main's words when Try again went unanswered, else the move's own reason. */
function failingWhy(line: AccountMoveLine, unanswered: string | null): string {
  const plain = t("cloudSend.move.failingPlain");
  return [unanswered && unanswered !== plain ? unanswered : line.reason, ...line.extra].filter(Boolean).join(" ") || plain;
}

/** The move's rows at the top of the account menu, each the size of every other row there. Failed: Try again, with why
 * in its tooltip and a spinner while it runs. On its way: one row, the progress in its tooltip. Done: what arrived, the
 * phone to pair, and Got it, which closes it for good. A row that does not retry opens My Cloud in Settings. */
export function moveMenuItems(line: AccountMoveLine | null, { retrying = false, unanswered = null, onOpen, onRetry, onPairPhone, onClose }: {
  retrying?: boolean;
  unanswered?: string | null;
  onOpen: () => void;
  onRetry: () => void;
  onPairPhone?: () => void;
  onClose: () => void;
}): SidebarMenuItem[] {
  if (!line) return [];
  if (line.kind === "failed") {
    const title = failingWhy(line, unanswered);
    if (!line.retry) return [{ key: "cloud-move", label: t("sidebar.account.moveNeedsYou"), title, icon: <CloudAlert size={16} className="text-warning" />, onSelect: onOpen }];
    return [{
      key: "cloud-move",
      label: t("sidebar.account.moveRetry"),
      title,
      icon: retrying ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} className="text-warning" />,
      disabled: retrying,
      keepOpen: true,
      onSelect: onRetry,
    }];
  }
  if (line.kind === "sending") return [{ key: "cloud-move", label: t("sidebar.account.moving"), title: line.text, icon: <Loader2 size={16} className="animate-spin" />, onSelect: onOpen }];
  return [
    { key: "cloud-move", label: line.text, ...(line.extra.length ? { note: line.extra.join(" ") } : {}), wrap: true, icon: <CloudCheck size={16} />, onSelect: onOpen },
    ...(line.phone && onPairPhone ? [{ key: "cloud-move-phone", label: t("cloudSend.move.phone"), icon: <Smartphone size={16} />, onSelect: onPairPhone }] : []),
    { key: "cloud-move-close", label: t("sidebar.account.moveDismiss"), icon: <X size={16} />, onSelect: onClose },
  ];
}

type RetryState = { retrying: boolean; unanswered: string | null };
const IDLE: RetryState = { retrying: false, unanswered: null };

function retryStore() {
  let state = IDLE;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: RetryState) => { state = next; for (const listener of listeners) listener(); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

// The window has one move, so the account's line and every account menu share its one Try again.
const retries = new WeakMap<CloudSendPageBridge, ReturnType<typeof retryStore>>();
const offPage = retryStore();
function retryOf(bridge: CloudSendPageBridge | undefined) {
  if (!bridge) return offPage;
  const known = retries.get(bridge);
  if (known) return known;
  const store = retryStore();
  retries.set(bridge, store);
  return store;
}

function useMove(cloudHome: boolean) {
  const bridge = pageBridge();
  const [notice, setNotice] = useCloudSendNotice(bridge);
  const store = retryOf(bridge);
  const { retrying, unanswered } = useSyncExternalStore(store.subscribe, store.get, store.get);
  const line = bridge && notice?.move ? moveLine(notice.move, cloudHome ? "cloud" : "local") : null;
  if (!bridge || !notice || !line) return null;
  const retry = () => {
    if (store.get().retrying) return;
    store.set({ retrying: true, unanswered: null });
    void (bridge.moveRetry?.() ?? Promise.resolve(notice)).then((next) => { setNotice(next); store.set(IDLE); })
      .catch((cause: unknown) => { store.set({ retrying: false, unanswered: ipcErrorText(cause) ?? t("cloudSend.move.failingPlain") }); });
  };
  const close = () => { void bridge.dismiss(MOVE_LINE).then(setNotice).catch(() => {}); };
  return { line, retrying, unanswered, retry, close };
}

/** The move as the account menu shows it: its kind and its rows, with the move's own Try again and close. */
export function useAccountMove(cloudHome: boolean, { onOpen, onPairPhone }: { onOpen: () => void; onPairPhone?: () => void }): {
  kind: AccountMoveKind | null;
  items: SidebarMenuItem[];
} {
  const move = useMove(cloudHome);
  if (!move) return { kind: null, items: [] };
  const { line, retrying, unanswered, retry, close } = move;
  return { kind: line.kind, items: moveMenuItems(line, { retrying, unanswered, onOpen, onRetry: retry, onPairPhone, onClose: close }) };
}

/** The line's Try again: what it runs, whether it is running, and why the move failed. */
export interface AccountMoveRetry {
  onRetry: () => void;
  retrying: boolean;
  why: string;
}

/** The move as Simple's line above the account shows it: its kind, and Try again while the failing move allows one. */
export function useAccountMoveLine(cloudHome: boolean): { kind: AccountMoveKind | null; retry: AccountMoveRetry | null } {
  const move = useMove(cloudHome);
  if (!move) return { kind: null, retry: null };
  const { line, retrying, unanswered, retry } = move;
  return { kind: line.kind, retry: line.kind === "failed" && line.retry ? { onRetry: retry, retrying, why: failingWhy(line, unanswered) } : null };
}

/** The account's line for the move: amber while it needs the person, quiet while it goes, nothing otherwise. With
 * `onOpen` its words are a button that opens the account menu, followed by Try again when `retry` allows one; without,
 * words inside a trigger. The words shorten before Try again does. */
export function AccountMoveStatus({ kind, retry = null, onOpen, className }: { kind: AccountMoveKind | null; retry?: AccountMoveRetry | null; onOpen?: () => void; className?: string }) {
  const words = accountMoveWords(kind);
  if (!words) return null;
  const Icon = kind === "failed" ? CloudAlert : CloudUpload;
  const look = cn("flex min-w-0 items-center gap-1.5 text-start text-[12px] leading-4", kind === "failed" ? "font-medium text-warning" : "text-ink-secondary");
  const body = <>
    <Icon size={13} aria-hidden="true" className="shrink-0" />
    <span className="truncate">{words}</span>
  </>;
  if (!onOpen) return <span data-account-move={kind} className={cn(look, className)}>{body}</span>;
  return (
    <div role="status" data-account-move={kind} className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <button type="button" onClick={onOpen} className={cn(look, kind === "failed" ? "hover:underline" : "hover:text-ink")}>{body}</button>
      {kind === "failed" && retry && (
        <button
          type="button"
          data-move-retry
          aria-label={t("sidebar.account.moveRetryName")}
          aria-busy={retry.retrying || undefined}
          aria-disabled={retry.retrying || undefined}
          title={retry.why}
          onClick={retry.retrying ? undefined : retry.onRetry}
          className={cn("ui-button ui-button-sm shrink-0", retry.retrying && "cursor-progress")}
        >
          {retry.retrying && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />}
          {t("cloudSend.strip.retry")}
        </button>
      )}
    </div>
  );
}
