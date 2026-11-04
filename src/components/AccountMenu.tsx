import { useEffect, useState } from "react";
import { Check, LogOut, UserRound, X } from "lucide-react";
import type { AccountsView } from "../../electron/cloud-account.mjs";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { CLOSE, Heading, PRIMARY, SCREEN, SHEET } from "./cloud-buy/parts";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

export interface AccountsAccess {
  /** This app's own page: the list itself. Any other page has none. */
  view: AccountsView | null;
  /** Another page: main opens the sheet on the rail's page for it. */
  openSheet: (() => void) | null;
  signOut(id: string): void;
}

/** Who is signed in on this device, on this app's own page; on any other page, only whether main offers the sheet. */
export function useAccounts(): AccountsAccess {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.accounts;
  const sheet = window.ogb?.accountSheet;
  const own = window.ogb?.app?.ownPage === true && Boolean(bridge);
  const [view, setView] = useState<AccountsView | null>(null);
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (!own) return;
    const read = () => { void bridge!.list().then(setView).catch(() => {}); };
    read();
    return bridge!.onChanged(read);
  }, [own, bridge]);
  useEffect(() => {
    if (own || !sheet) return;
    let alive = true;
    void sheet.offered().then((yes) => { if (alive) setOffered(yes === true); }).catch(() => {});
    return () => { alive = false; };
  }, [own, sheet]);
  return {
    view: own ? view : null,
    openSheet: !own && offered && sheet ? () => { void sheet.open().catch(() => {}); } : null,
    signOut: (id) => { void bridge?.signOut(id).then(setView).catch(() => {}); },
  };
}

/** The You menu's row for the MausBot Cloud page, on this app's own page: Sign in while nobody is signed in here, so whoever was
 * told to sign in finds the words. Any other page knows nothing of who is signed in. */
export function cloudRowLabel(view: AccountsView | null): string {
  return t(view && !view.active ? "accounts.signIn" : "settings.section.cloudAccount");
}

/** The You menu's last rows. On another page, one row that opens the sheet. Signed out: nothing, as Settings has the sign-in. */
export function accountMenuItems({ view, openSheet, signOut }: AccountsAccess): SidebarMenuItem[] {
  if (openSheet) return [{ key: "accounts-sheet", label: t("accounts.manage"), icon: <UserRound size={18} />, onSelect: openSheet }];
  const active = view?.active;
  if (!active) return [];
  return [
    { key: "accounts-active", heading: t("accounts.heading"), label: active.email, title: active.email, icon: <Check size={18} />, disabled: true, onSelect: () => {} },
    { key: "accounts-sign-out", label: t("accounts.signOut"), icon: <LogOut size={18} />, onSelect: () => signOut(active.id) },
  ];
}

/** Over any place's page, on the rail's own page: who is signed in here and Sign out. */
export function AccountsSheet({ onClose }: { onClose: () => void }) {
  const bridge = window.ogb?.accounts;
  const [view, setView] = useState<AccountsView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    const read = () => { void bridge.list().then(setView).catch(() => setFailed(true)); };
    read();
    return bridge.onChanged(read);
  }, [bridge]);
  const active = view?.active ?? null;
  const signOut = (id: string) => {
    setFailed(false);
    void bridge?.signOut(id).then((next) => { setView(next); if (!next.active) onClose(); }, () => setFailed(true));
  };
  return <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" aria-labelledby="cloud-add-title" data-accounts-sheet className={cn(SHEET, "relative w-full max-w-[420px]")}>
      <button type="button" onClick={onClose} aria-label={t("accounts.close")} className={cn(CLOSE, "absolute end-4 top-4 z-10")}><X size={16} /></button>
      <div className={SCREEN}>
        <Heading title={t("accounts.title")} />
        {active && <p data-accounts-active className="truncate text-[14px] text-ink" title={active.email}>{t("accounts.heading")} {active.email}</p>}
        {active && <button type="button" data-accounts-sign-out className={PRIMARY} onClick={() => signOut(active.id)}>{t("accounts.signOut")}</button>}
        {failed && <p role="alert" className="text-[13px] text-danger">{t("accounts.failed")}</p>}
      </div>
    </div>
  </div>;
}

/** The sheet as the rail's page keeps it: asked for by main, from the person's click on the page beside the rail. */
export function useAccountsSheet(): { open: boolean; close: () => void } {
  const bridge = window.ogb?.accounts;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    void bridge.sheetPending().then((pending) => { if (pending) setOpen(true); }).catch(() => {});
    return bridge.onOpenSheet(() => setOpen(true));
  }, [bridge]);
  useEffect(() => { if (open) void window.ogb?.rail?.expand?.(true)?.catch(() => {}); }, [open]);
  return { open, close: () => {
    setOpen(false);
    void window.ogb?.rail?.expand?.(false)?.catch(() => {});
    void bridge?.sheetClosed().catch(() => {});
  } };
}
