import { useEffect, useState } from "react";
import { Check, LogOut, Plus, UserRound, X } from "lucide-react";
import type { AccountsView, AccountSwitchResult, RailOpenResult } from "../../electron/cloud-account.mjs";
import { cn } from "@/lib/cn";
import type { CloudSignInPhase } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { usePlaces } from "@/lib/places";
import { CLOSE, Heading, PRIMARY, QUIET, SCREEN, SHEET } from "./cloud-buy/parts";
import { codeDigits, SignInScreen } from "./cloud-buy/SignInScreen";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

export interface AccountsAccess {
  /** This app's own page: who is signed in. Any other page has none. */
  view: AccountsView | null;
  /** Another page: main opens the sheet on the rail's page for it. */
  openSheet: (() => void) | null;
  /** No rail stands beside this page, so its ＋ can't be where another account is added. */
  noRail: boolean;
  signOut(id: string): void;
  add(email?: string): void;
}

/** What a click or sign-out that didn't go through says; null when it went through. */
export function switchNote(result: Pick<RailOpenResult | AccountSwitchResult, "outcome">): string | null {
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
  const places = usePlaces();
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
  return {
    view: own ? view : null,
    openSheet: !own && offered && remote ? () => { void remote.open().catch(() => {}); } : null,
    noRail: !places.beside && !places.places.length,
    signOut: (id) => { void bridge?.signOut(id).then((result) => { setView(result.view); const note = switchNote(result); if (note) setSheet({ email: null, note }); }).catch(() => setSheet({ email: null, note: t("accounts.failed") })); },
    add: (email) => setSheet({ email: email ?? "", note: null }),
    sheet,
    closeSheet: () => setSheet(null),
  };
}

/** The You menu's row for the MausBot Cloud page, on this app's own page: Sign in while nobody is signed in here, so whoever was
 * told to sign in finds the words. Any other page knows nothing of who is signed in. */
export function cloudRowLabel(view: AccountsView | null): string {
  return t(view && !view.active ? "accounts.signIn" : "settings.section.cloudAccount");
}

/** The You menu's last rows: who is signed in here and Sign out. The other accounts are on the rail, and so is Add another account,
 * in its ＋; with no rail beside this page (nothing to list but This computer, or the person hid it) it is here. On another page,
 * one row that opens the sheet, with no address. Signed out: nothing, as Settings has the sign-in. */
export function accountMenuItems({ view, openSheet, noRail, signOut, add }: AccountsAccess): SidebarMenuItem[] {
  if (openSheet) return [{ key: "accounts-sheet", label: t("accounts.manage"), icon: <UserRound size={18} />, onSelect: openSheet }];
  const active = view?.active;
  if (!active) return [];
  return [
    { key: "accounts-active", heading: t("accounts.heading"), label: active.email, title: active.email, checked: true, icon: <Check size={18} />, disabled: !active.signIn, ...(active.signIn ? { subtitle: t("accounts.needsSignIn") } : {}), onSelect: () => { if (active.signIn) add(active.email); } },
    ...(noRail ? [{ key: "accounts-add", label: t("accounts.add"), icon: <Plus size={18} />, onSelect: () => add() }] : []),
    { key: "accounts-sign-out", label: t("accounts.signOut"), icon: <LogOut size={18} />, onSelect: () => signOut(active.id) },
  ];
}

const EMAIL_STEP: CloudSignInPhase = { step: "email", intent: false, problem: null };

/** Add another account in place: the emailed code, or the browser for single sign-on and two-step. The account in use goes
 * on until this succeeds; the code's attempt and the token stay in main. */
function AddAccount({ start, onDone, onBack }: { start: string; onDone: (note: string | null) => void; onBack: () => void }) {
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
      if (result.outcome === "sent") { setPhase({ step: "code", intent: false, email: result.email, resendAt: result.resendAt, problem: null, triesLeft: null, ...(result.signupOpen === false ? { signupOpen: false } : {}) }); setCode(""); }
      else setPhase({ step: "email", intent: false, problem: result.outcome });
    }, () => setPhase({ step: "email", intent: false, problem: "failed" })).finally(() => setBusy(false));
  };
  const verify = (digits: string) => {
    if (!bridge || phase.step !== "code") return;
    const at = phase;
    setBusy(true);
    void bridge.addVerify(digits).then((result) => {
      if (result.outcome === "switched") onDone(null);
      else if (result.outcome === "added") onDone(t("accounts.added", { email: result.email ?? email }));
      else if (result.outcome === "already") onDone(t("accounts.already", { email: result.email ?? email }));
      else { setCode(""); setPhase({ ...at, problem: result.outcome, triesLeft: result.outcome === "wrong-code" ? result.triesLeft : null }); }
    }, () => setPhase({ ...at, problem: "failed", triesLeft: null })).finally(() => setBusy(false));
  };
  // The browser's way ends in main, which says how once the list changes: the account in use now, kept for after a move, or the
  // one in use already. Nothing else tells the sheet, and it would wait on "Finish signing in" for ever.
  useEffect(() => {
    if (!browser || !bridge) return;
    const look = () => { void bridge.addResult().then((result) => {
      if (!result) return;
      if (result.outcome === "switched") onDone(null);
      else if (result.outcome === "added") onDone(t("accounts.added", { email: result.email ?? email }));
      else if (result.outcome === "already") onDone(t("accounts.already", { email: result.email ?? email }));
      else { setBrowser(false); setPhase({ step: "email", intent: false, problem: "failed" }); }
    }).catch(() => {}); };
    look();
    return bridge.onChanged(look);
  }, [browser, bridge, onDone, email]);
  if (browser) return <div data-accounts-browser className={SCREEN}>
    <Heading title={t("accounts.browserTitle")} sub={t("accounts.browserBody")} />
    <button type="button" className={QUIET} onClick={() => { void bridge?.addReopen().catch(() => {}); }}>{t("accounts.browserOpen")}</button>
  </div>;
  return <SignInScreen phase={phase} email={email} code={code} profileEmail={null} busy={busy} now={now} onBack={onBack} onEmail={setEmail} onSend={send}
    onChangeEmail={() => { setPhase(EMAIL_STEP); void bridge?.addCancel().catch(() => {}); }}
    onCode={(value) => { const digits = codeDigits(value); setCode(digits); if (digits.length === 8 && !busy) verify(digits); }}
    onResend={send} onBrowser={() => { setBusy(true); void bridge?.addBrowser().then((result) => { if (result.outcome === "browser") setBrowser(true); else setPhase({ step: "email", intent: false, problem: "failed" }); }, () => setPhase({ step: "email", intent: false, problem: "failed" })).finally(() => setBusy(false)); }} />;
}

/** Over any place's page, on the rail's own page, or over this computer's: who is signed in here and Sign out, or a plain line
 * (`note`). `adding`: the sign-in, for this address when it has one: Add another account, or a saved account whose sign-in ended. */
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
  const signOut = (id: string) => {
    setNote(null);
    void bridge?.signOut(id).then((result) => {
      setView(result.view);
      const said = switchNote(result);
      if (said) setNote(said); else onClose();
    }, () => setNote(t("accounts.failed")));
  };
  const active = view?.active ?? null;
  return <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" aria-labelledby="cloud-add-title" data-accounts-sheet className={cn(SHEET, "relative w-full max-w-[420px]")}>
      <button type="button" onClick={onClose} aria-label={t("accounts.close")} className={cn(CLOSE, "absolute end-4 top-4 z-10")}><X size={16} /></button>
      {add !== null
        ? <AddAccount start={add} onBack={() => (adding !== null ? onClose() : setAdd(null))} onDone={(said) => { setAdd(null); if (said) setNote(said); else onClose(); }} />
        : <div className={SCREEN}>
          <Heading title={t("accounts.title")} />
          {active && !given && <p data-accounts-active className="truncate text-[14px] text-ink" title={active.email}>{t("accounts.heading")} {active.email}</p>}
          {note && <p role="status" data-accounts-note className="text-[13px] leading-5 text-ink-secondary">{note}</p>}
          {active && !given && <button type="button" data-accounts-sign-out className={PRIMARY} onClick={() => signOut(active.id)}>{t("accounts.signOut")}</button>}
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
