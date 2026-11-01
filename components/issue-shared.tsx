"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { ContentSkeleton } from "./content-skeleton";
import { Dialog } from "./dialog";
import { taskKey } from "@/lib/project-issues";

/** Types and pieces shared by the board (project-issues.tsx) and the issue view (issue-detail.tsx). */
export type ProjectWithUi = Doc<"projects"> & { memberRole: string; iconUrl?: string | null };
export type OpenReference = (projectId: Id<"projects">, taskId?: Id<"tasks">) => void;

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return <ContentSkeleton label={label} kind={label.includes("board") || label.includes("project") ? "board" : "list"} rows={4} />;
}

/**
 * The issue a composer just created, for the board to focus its card once it shows. The composer may switch projects
 * first, so a board that mounts right after the create still gets it.
 */
let createdIssue: { taskId: string; at: number } | null = null;
const createdListeners = new Set<(taskId: string) => void>();
export function announceCreatedIssue(taskId: string) {
  createdIssue = { taskId, at: Date.now() };
  createdListeners.forEach(listener => listener(taskId));
}
export function subscribeCreatedIssue(listener: (taskId: string) => void) {
  if (createdIssue && Date.now() - createdIssue.at < 3000) listener(createdIssue.taskId);
  createdListeners.add(listener);
  return () => { createdListeners.delete(listener); };
}

/**
 * The one way to delete an issue (the board's card menu and the issue view's ⋯ menu): a confirm dialog naming the
 * issue, with Cancel and Delete. `onCancel` also runs for Escape and the close button.
 */
export function IssueDeleteDialog({ taskId, title, disabled, onCancel, onConfirm }: { taskId: string; title: string; disabled?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <Dialog title="Delete issue" className="confirm-dialog" onClose={onCancel}>
    <div className="dialog-body">
      <p className="confirm-text"><span className="issue-key">{taskKey(taskId)}</span> {title}</p>
      <div className="dialog-actions">
        <button type="button" className="ghost-button compact" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button danger compact" autoFocus disabled={disabled} onClick={onConfirm}>Delete</button>
      </div>
    </div>
  </Dialog>;
}

/**
 * The one confirmation toast for issue actions (Completed, Moved to, Link copied) and chat (Copied), on the board, in
 * the issue view and in chat. Any surface calls `showIssueToast`; the first mounted `IssueToastHost` shows it.
 * It never covers a menu or sheet: opening one dismisses it, and one already open keeps a new toast from showing.
 */
export type IssueToast = { id: number; text: string; icon?: ReactNode; undo?: () => void };
/** A toast with Undo stays long enough to use it; a plain confirmation goes sooner. */
const toastMs = (toast: IssueToast) => toast.undo ? 5000 : 2500;
let toastSeq = 0;
let toastState: { toast: IssueToast | null; hosts: number[] } = { toast: null, hosts: [] };
const toastListeners = new Set<() => void>();
const setToastState = (next: Partial<typeof toastState>) => { toastState = { ...toastState, ...next }; toastListeners.forEach(listener => listener()); };
const subscribeToast = (listener: () => void) => { toastListeners.add(listener); return () => { toastListeners.delete(listener); }; };
let toastTimer: number | undefined;
const expireToast = (toast: IssueToast, ms = toastMs(toast)) => {
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { if (toastState.toast?.id === toast.id) setToastState({ toast: null }); }, ms);
};
/** Menus, pickers, sheets and dialogs: what a toast must never sit on. */
const OVERLAY = '[popover]:not(.board-toast), [role="menu"], [role="listbox"], .task-menu-layer, .message-menu-layer, dialog';
const overlayOpen = () => Boolean(document.querySelector('[popover]:popover-open:not(.board-toast), .task-menu-layer, .message-menu-layer'));
export function showIssueToast(text: string, undo?: () => void, icon?: ReactNode) {
  const toast = { id: ++toastSeq, text, undo, icon };
  expireToast(toast);
  setToastState({ toast });
}
export function dismissIssueToast() { window.clearTimeout(toastTimer); setToastState({ toast: null }); }

let hostSeq = 0;
export function IssueToastHost() {
  const [id] = useState(() => ++hostSeq);
  useEffect(() => {
    setToastState({ hosts: [...toastState.hosts, id] });
    return () => setToastState({ hosts: toastState.hosts.filter(host => host !== id) });
  }, [id]);
  const state = useSyncExternalStore(subscribeToast, () => toastState, () => toastState);
  if (!state.toast || state.hosts[0] !== id) return null;
  return <ToastView key={state.toast.id} toast={state.toast} />;
}

/** The text boxes at the bottom of a view (issue comments, chat) that a toast sits above. */
const TOAST_FLOOR = ".issue-detail-composer, .rich-composer";

/** The modal dialog on top (dialogs are portaled to the body in opening order), if one is open. */
function topDialog() {
  return [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter(dialog => dialog.matches(":modal")).at(-1) ?? null;
}

/**
 * A top-layer popover, so it shows above an open issue as well as on the board. While a modal dialog is open it lives
 * inside that dialog, where it is not inert, so Undo stays clickable. It sits above a comment or message box.
 */
function ToastView({ toast }: { toast: IssueToast }) {
  const ref = useRef<HTMLDivElement>(null);
  const [home, setHome] = useState<HTMLElement>(() => topDialog() ?? document.body);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Shown once the menu that raised it has closed; a menu or sheet that stays open keeps it away.
    let frame = 0, waited = 0;
    const show = () => {
      if (overlayOpen()) {
        if (++waited > 20) dismissIssueToast(); else frame = requestAnimationFrame(show);
        return;
      }
      // Above the comment or message box (inside a dialog: above its bottom edge), never over what the person types.
      const box = [...home.querySelectorAll(TOAST_FLOOR)].find(item => item.getClientRects().length);
      const floor = box?.getBoundingClientRect().top ?? (home === document.body ? null : home.getBoundingClientRect().bottom - 12);
      if (floor !== null) element.style.bottom = `${Math.max(24, window.innerHeight - floor + 8)}px`;
      try { element.showPopover(); } catch { /* Already shown or unsupported: it still renders in place. */ }
    };
    frame = requestAnimationFrame(show);
    return () => { cancelAnimationFrame(frame); try { if (element.matches(":popover-open")) element.hidePopover(); } catch { /* gone */ } };
  }, [home]);
  useEffect(() => {
    // Something opened over the page (a menu, picker, sheet or another dialog): get out of its way.
    const opened = (node: Node) => node instanceof Element && (node.matches(OVERLAY) || Boolean(node.querySelector(OVERLAY)));
    const observer = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(opened))) { dismissIssueToast(); return; }
      const top = topDialog();
      if (top && top !== home) dismissIssueToast();
      // The dialog it lived in closed: stay on the page underneath for the rest of its time.
      else if (!top && home !== document.body) setHome(document.body);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    const onToggle = (event: Event) => { if ((event as ToggleEvent).newState === "open" && event.target !== ref.current) dismissIssueToast(); };
    document.addEventListener("toggle", onToggle, true);
    return () => { observer.disconnect(); document.removeEventListener("toggle", onToggle, true); };
  }, [home]);
  // A press on the toast holds it, so it cannot vanish under the finger and let the tap land on what is below.
  const hold = () => window.clearTimeout(toastTimer);
  const release = () => expireToast(toast, 2000);
  return createPortal(<div ref={ref} popover="manual" className="board-toast" role="status" onPointerDown={hold} onPointerUp={release} onPointerCancel={release}>
    <span className="board-toast-icon">{toast.icon ?? <Check size={14} />}</span>
    <span>{toast.text}</span>
    {toast.undo && <button type="button" onClick={() => { toast.undo?.(); dismissIssueToast(); }}>Undo</button>}
  </div>, home);
}
