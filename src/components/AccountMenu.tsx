import { useEffect, useState } from "react";
import { Check, LogOut, Plus, UserRound, X } from "lucide-react";
import type { AccountRow, AccountsView, AccountSwitchResult } from "../../electron/cloud-account.mjs";
import { cn } from "@/lib/cn";
import type { CloudSignInPhase } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { CLOSE, Heading, QUIET, SCREEN, SHEET } from "./cloud-buy/parts";
import { codeDigits, SignInScreen } from "./cloud-buy/SignInScreen";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

export interface AccountsAccess {
  /** This app's own page: the list itself. Any other page has none. */
  view: AccountsView | null;
  /** Another page: main opens the sheet on the rail's page for it. */
  openSheet: (() => void) | null;
  switchTo(row: AccountRow): void;
  signOut(id: string): void;
  add(email?: string): void;
}

/** What a switch or sign-out that didn't go through says; null when it went through. */
export function switchNote(result: Pick<AccountSwitchResult, "outcome">): string | null {
  switch (result.outcome) {
    case "moving": return t("accounts.moving");
    case "gone": return t("accounts.gone");
    case "failed": return t("accounts.failed");
    default: return null;
  }
}

/** Who is signed in on this device, on this app's own page; on any other page, only whether main offers the sheet. */
export function useAccounts(): AccountsAccess & { sheet: { email: string | null; note: string | null } | null; closeSheet(): void } {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.accounts;
  const remote = window.ogb?.accountSheet;
  const own = window.ogb?.app?.ownPage === true && Boolean(bridge);
  const [view, setView] = useState<AccountsView | null>(null);
  const [offered, setOffered] = useState(false);
  const [sheet, setSheet] = useState<{ email: string | null; note: string | null } | null>(null);
  useEffect(() => {
    if (!own) return;
    const read = () => { void bridge!.list().then(setView).catch(() => {}); };
    read();
    return bridge!.onChanged(read);
  }, [own, bridge]);
  useEffect(() => {
    if (own || !remote) return;
    let alive = true;
    void remote.offered().then((yes) => { if (alive) setOffered(yes === true); }).catch(() => {});
    return () => { alive = false; };
  }, [own, remote]);
  const said = (result: AccountSwitchResult, row?: AccountRow) => {
    setView(result.view);
    if (result.outcome === "sign-in") setSheet({ email: row?.email ?? null, note: null });
    else { const note = switchNote(result); if (note) setSheet({ email: null, note }); }
  };
  return {
    view: own ? view : null,
    openSheet: !own && offered && remote ? () => { void remote.open().catch(() => {}); } : null,
    switchTo: (row) => {
      if (row.signIn) { setSheet({ email: row.email, note: null }); return; }
      void bridge?.switchTo(row.id).then((result) => said(result, row)).catch(() => setSheet({ email: null, note: t("accounts.failed") }));
    },
    signOut: (id) => { void bridge?.signOut(id).then((result) => said(result)).catch(() => setSheet({ email: null, note: t("accounts.failed") })); },
    add: (email) => setSheet({ email: email ?? "", note: null }),
    sheet,
    closeSheet: () => setSheet(null),
  };
}

/** The You menu's last rows. One account: its address, Add another account, Sign out. On another page, one row that opens
 * the sheet. Signed out here: Sign in, as anyone with no account yet has. */
export function accountMenuItems({ view, openSheet, switchTo, signOut, add }: AccountsAccess): SidebarMenuItem[] {
  if (openSheet) return [{ key: "accounts-sheet", label: t("accounts.manage"), icon: <UserRound size={18} />, onSelect: openSheet }];
  if (!view) return [];
  const active = view.active;
  if (!active && !view.others.length) return [];
  return [
    ...(active ? [{ key: "accounts-active", heading: t("accounts.heading"), label: active.email, title: active.email, checked: true, icon: <Check size={18} />, disabled: !active.signIn, ...(active.signIn ? { subtitle: t("accounts.needsSignIn") } : {}), onSelect: () => { if (active.signIn) add(active.email); } }] : []),
    ...view.others.map((row) => ({ key: `accounts-${row.id}`, label: row.email, title: row.email, checked: false, icon: <UserRound size={18} />, ...(row.signIn ? { subtitle: t("accounts.needsSignIn") } : {}), onSelect: () => switchTo(row) })),
    { key: "accounts-add", label: t("accounts.add"), icon: <Plus size={18} />, onSelect: () => add() },
    ...(active ? [{ key: "accounts-sign-out", label: t("accounts.signOut"), icon: <LogOut size={18} />, onSelect: () => signOut(active.id) }] : []),
  ];
}

const EMAIL_STEP: CloudSignInPhase = { step: "email", intent: false, problem: null };

/** Add another account in place: the emailed code, or the browser for single sign-on and two-step. The account in use goes
 * on until this succeeds; the code's attempt and the token stay in main. */
function AddAccount({ start, onDone, onBack }: { start: string; onDone: (note: string | null, view?: AccountsView) => void; onBack: () => void }) {
  const bridge = window.ogb?.accounts;
  const [phase, setPhase] = useState<CloudSignInPhase>(EMAIL_STEP);
  const [email, setEmail] = useState(start);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => () => { void bridge?.addCancel().catch(() => {}); }, [bridge]);
  const send = () => {
    if (busy || !bridge) return;
    setBusy(true);
    void bridge.addStart(email).then((result) => {
      if (result.outcome === "sent") { setPhase({ step: "code", intent: false, email: result.email, resendAt: result.resendAt, problem: null, triesLeft: null, ...(result.signupOpen === false ? { signupOpen: false } : {}) }); setEmail(result.email); setCode(""); }
      else setPhase({ step: "email", intent: false, problem: result.outcome });
    }, () => setPhase({ step: "email", intent: false, problem: "failed" })).finally(() => setBusy(false));
  };
  const verify = (digits: string) => {
    if (!bridge || phase.step !== "code") return;
    const at = phase;
    setBusy(true);
    void bridge.addVerify(digits).then((result) => {
      if (result.outcome === "switched") onDone(null, result.view);
      else if (result.outcome === "added") onDone(t("accounts.added", { email: result.email ?? email }), result.view);
      else if (result.outcome === "already") onDone(t("accounts.already", { email: result.email ?? email }), result.view);
      else { setCode(""); setPhase({ ...at, problem: result.outcome, triesLeft: result.outcome === "wrong-code" ? result.triesLeft : null }); }
    }, () => setPhase({ ...at, problem: "failed", triesLeft: null })).finally(() => setBusy(false));
  };
  // The browser's way ends in main; the sheet closes once the account it brought is the one in use.
  useEffect(() => {
    if (!browser || !bridge) return;
    let before: AccountRow | null | undefined;
    const look = () => { void bridge.list().then((view) => {
      if (before === undefined) { before = view.active; return; }
      if (view.active && !view.active.signIn && (view.active.id !== before?.id || before?.signIn)) onDone(null, view);
    }).catch(() => {}); };
    look();
    return bridge.onChanged(look);
  }, [browser, bridge, onDone]);
  if (browser) return <div data-accounts-browser className={SCREEN}>
    <Heading title={t("accounts.browserTitle")} sub={t("accounts.browserBody")} />
    <button type="button" className={QUIET} onClick={() => { void bridge?.addReopen().catch(() => {}); }}>{t("accounts.browserOpen")}</button>
  </div>;
  return <SignInScreen phase={phase} email={email} code={code} profileEmail={null} busy={busy} now={now} onBack={onBack} onEmail={setEmail} onSend={send}
    onChangeEmail={() => { setPhase(EMAIL_STEP); void bridge?.addCancel().catch(() => {}); }}
    onCode={(value) => { const digits = codeDigits(value); setCode(digits); if (digits.length === 8 && !busy) verify(digits); }}
    onResend={send} onBrowser={() => { setBusy(true); void bridge?.addBrowser().then((result) => { if (result.outcome === "browser") setBrowser(true); else setPhase({ step: "email", intent: false, problem: "failed" }); }, () => setPhase({ step: "email", intent: false, problem: "failed" })).finally(() => setBusy(false)); }} />;
}

/** Over any place's page, on the rail's own page, or over this computer's: who is signed in here, the others, Add another
 * account and Sign out. `adding`: straight to the sign-in, for this address when it has one. */
export function AccountsSheet({ onClose, adding = null, note: given = null }: { onClose: () => void; adding?: string | null; note?: string | null }) {
  const bridge = window.ogb?.accounts;
  const [view, setView] = useState<AccountsView | null>(null);
  const [note, setNote] = useState<string | null>(given);
  const [add, setAdd] = useState<string | null>(adding);
  useEffect(() => {
    if (!bridge) return;
    const read = () => { void bridge.list().then(setView).catch(() => setNote(t("accounts.failed"))); };
    read();
    return bridge.onChanged(read);
  }, [bridge]);
  const act = (work: Promise<AccountSwitchResult> | undefined, row?: AccountRow) => {
    setNote(null);
    void work?.then((result) => {
      setView(result.view);
      if (result.outcome === "sign-in") setAdd(row?.email ?? "");
      else { const said = switchNote(result); if (said) setNote(said); else onClose(); }
    }, () => setNote(t("accounts.failed")));
  };
  const active = view?.active ?? null;
  return <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" aria-labelledby="cloud-add-title" data-accounts-sheet className={cn(SHEET, "relative w-full max-w-[420px]")}>
      <button type="button" onClick={onClose} aria-label={t("accounts.close")} className={cn(CLOSE, "absolute end-4 top-4 z-10")}><X size={16} /></button>
      {add !== null
        ? <AddAccount start={add} onBack={() => setAdd(null)} onDone={(said, next) => { if (next) setView(next); setAdd(null); if (said) setNote(said); else onClose(); }} />
        : <div className={SCREEN}>
          <Heading title={t("accounts.title")} />
          <ul className="flex flex-col gap-1">
            {active && <li data-accounts-active className="flex min-h-[36px] items-center gap-2 text-[14px] text-ink"><Check size={16} aria-label={t("accounts.heading")} /><span className="truncate" title={active.email}>{active.email}</span></li>}
            {(view?.others ?? []).map((row) => <li key={row.id}>
              <button type="button" data-accounts-other={row.id} className="flex min-h-[36px] w-full items-center gap-2 rounded-lg px-1 text-start text-[14px] text-ink hover:bg-ink/[0.05]" onClick={() => (row.signIn ? setAdd(row.email) : act(bridge?.switchTo(row.id), row))}>
                <UserRound size={16} aria-hidden="true" /><span className="min-w-0 flex-1 truncate" title={row.email}>{row.email}</span>
                {row.signIn && <span className="shrink-0 text-[12px] text-ink-secondary">{t("accounts.needsSignIn")}</span>}
              </button>
            </li>)}
          </ul>
          {note && <p role="status" className="text-[13px] leading-5 text-ink-secondary">{note}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" data-accounts-add className={QUIET} onClick={() => setAdd("")}>{t("accounts.add")}</button>
            {active && <button type="button" data-accounts-sign-out className={QUIET} onClick={() => act(bridge?.signOut(active.id))}>{t("accounts.signOut")}</button>}
          </div>
        </div>}
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
