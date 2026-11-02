import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { LocaleKey } from "@/locales";
import { ConfirmDialog } from "./ConfirmDialog";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { DeviceSignIn, deviceSignInProvider } from "./DeviceSignIn";
import { ChatGptPlanStatus } from "./ChatGptPlanStatus";
import { EngineCard, engineReady, providerName, type EngineCardSummary } from "./EngineLibrary";
import { CommandRow, EngineSetup, EngineUpdateNotice, EngineWarningNotice } from "./EngineSetup";
import { MENU_SHEET } from "./menu-recipe";

/** Providers whose accounts are listed together on one card, each signed in on its own. */
export type AccountGroup = "claude" | "chatgpt";

export function accountGroupOf(instance: InstanceInfo): AccountGroup | null {
  if (instance.readOnly || instance.trialCredit || instance.access === "custom" || instance.access === "api") return null;
  if (instance.driverKind === "claudeAgent") return "claude";
  const method = instance.authentication?.method;
  return instance.snapshot.chatgptPlan === true || ((method === "device-code" || method === "browser-pkce") && deviceSignInProvider(instance.driverKind) === "codex")
    ? "chatgpt" : null;
}

type AccountState = "signedIn" | "signedOut" | "unknown" | "unavailable";

function accountState(instance: InstanceInfo): AccountState {
  if (instance.snapshot.state !== "available") return "unavailable";
  return instance.snapshot.authenticated === true ? "signedIn" : instance.snapshot.authenticated === false ? "signedOut" : "unknown";
}

const COPY: Record<AccountGroup, Record<"title" | "add" | "removeBody", LocaleKey>> = {
  claude: { title: "accounts.claude", add: "accounts.addClaude", removeBody: "accounts.removeBodyClaude" },
  chatgpt: { title: "accounts.chatgpt", add: "accounts.addChatgpt", removeBody: "accounts.removeBodyChatgpt" },
};

/** What an account's menu offers. Only accounts added here can be removed; each provider's first account stays. */
export function accountActions(group: AccountGroup, instance: InstanceInfo): { signOut: boolean; remove: boolean } {
  return {
    signOut: accountState(instance) === "signedIn" && instance.authentication?.signOut === true && instance.snapshot.account?.method !== "api-key",
    remove: group === "claude" ? instance.instanceId !== "claude" && instance.claudeAccount?.isDefault !== true : instance.instanceId.startsWith("chatgpt-"),
  };
}

/** Ready while any account can run a turn: the same rule a single provider card uses. */
export function accountsReady(accounts: InstanceInfo[]): boolean {
  return accounts.some(engineReady);
}

function summaryFor(group: AccountGroup, accounts: InstanceInfo[]): EngineCardSummary {
  const signedIn = accounts.filter((instance) => accountState(instance) === "signedIn");
  const ready = accountsReady(accounts);
  const installed = accounts.some((instance) => instance.snapshot.state === "available");
  const subtitle = accounts.length > 1
    ? t("accounts.count", { count: String(accounts.length), signedIn: String(signedIn.length) })
    : signedIn[0]?.snapshot.account?.email ?? providerName(accounts[0]!);
  return {
    title: t(COPY[group].title),
    subtitle,
    ready,
    status: ready ? t("onboarding.engines.ready") : installed ? t("model.signInRequired") : t("onboarding.engines.needsSetup"),
    action: ready ? t("engines.library.manage") : installed ? t("accounts.signIn") : t("engines.library.setup"),
  };
}

function AccountMenu({ group, instance, onRename }: { group: AccountGroup; instance: InstanceInfo; onRename: () => void }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"signOut" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { signOut: canSignOut, remove: canRemove } = accountActions(group, instance);
  const usedBy = state.bots.filter((bot) => bot.modelSelection.instanceId === instance.instanceId).length;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const run = async (action: "signOut" | "remove") => {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      const path = `/api/instances/${encodeURIComponent(instance.instanceId)}${action === "signOut" ? "/auth/sign-out" : ""}`;
      const { instances } = await api(path, action === "signOut" ? { method: "POST" } : { method: "DELETE" });
      // The response is the confirmed state: a second request could fail and leave a stale row.
      if (Array.isArray(instances)) dispatch({ type: "instances", instances });
      else await refreshInstances().catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const item = "ui-menu-row w-full text-left disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div ref={menuRef} className="relative flex items-center gap-1">
      {canRemove && <button type="button" disabled={busy || usedBy > 0} onClick={() => setConfirm("remove")}
        title={usedBy > 0 ? t("accounts.inUse", { count: String(usedBy) }) : undefined}
        className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50">
        {t("accounts.remove")}
      </button>}
      <button type="button" onClick={() => setOpen((value) => !value)} disabled={busy} aria-haspopup="menu" aria-expanded={open}
        aria-label={t("accounts.menu", { name: instance.displayName })}
        className="flex size-8 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={16} />}
      </button>
      {open && (
        <div role="menu" className={cn("absolute right-0 top-full z-40 mt-1 w-[220px] overflow-hidden text-[13px]", MENU_SHEET)}>
          <button type="button" role="menuitem" className={cn(item, "text-ink")} onClick={() => { setOpen(false); onRename(); }}>{t("accounts.rename")}</button>
          {canSignOut && <button type="button" role="menuitem" className={cn(item, "text-ink")} onClick={() => { setOpen(false); setConfirm("signOut"); }}>{t("accounts.signOut")}</button>}
          {canRemove && usedBy > 0 && <p className="px-3 pb-1 pt-0.5 text-[11px] leading-snug text-ink-secondary">{t("accounts.inUse", { count: String(usedBy) })}</p>}
        </div>
      )}
      {error && <p role="alert" className="absolute right-0 top-full z-30 mt-1 w-[260px] rounded-lg bg-card p-2 text-[12px] text-danger shadow-lg">{error}</p>}
      <ConfirmDialog
        open={confirm === "signOut"}
        title={t("accounts.signOutTitle", { name: instance.displayName })}
        body={t("accounts.signOutBody")}
        confirmLabel={t("accounts.signOut")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run("signOut")}
      />
      <ConfirmDialog
        open={confirm === "remove"}
        title={t("accounts.removeTitle", { name: instance.displayName })}
        body={t(COPY[group].removeBody)}
        confirmLabel={t("accounts.remove")}
        tone="neutral"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run("remove")}
      />
    </div>
  );
}

function RenameForm({ instance, onDone }: { instance: InstanceInfo; onDone: () => void }) {
  const { dispatch } = useStore();
  const [name, setName] = useState(instance.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const next = name.trim();
    if (!next || next === instance.displayName) return onDone();
    setSaving(true);
    setError(null);
    try {
      const { instances } = await api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "PATCH", body: JSON.stringify({ displayName: next }) });
      if (Array.isArray(instances)) dispatch({ type: "instances", instances });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="flex min-w-0 flex-1 flex-col gap-1" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="flex gap-2">
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus disabled={saving}
          aria-label={t("accounts.nameLabel")}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onDone(); } }}
          className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent-border disabled:opacity-50" />
        <button type="submit" disabled={saving || !name.trim()} className="rounded-lg bg-raised px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50">
          {saving ? <Loader2 size={13} className="animate-spin" /> : t("common.save")}
        </button>
        <button type="button" onClick={onDone} disabled={saving} className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control">{t("common.cancel")}</button>
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </form>
  );
}

function AccountRow({ group, instance, signingIn, onSignIn, onSignInDone }: {
  group: AccountGroup;
  instance: InstanceInfo;
  signingIn: boolean;
  onSignIn: () => void;
  onSignInDone: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const state = accountState(instance);
  const account = instance.snapshot.account;
  // This server cannot run the provider's sign-in (a remote browser for a local-only flow): say why, offer nothing.
  const blocked = instance.snapshot.authenticationUnavailableReason;
  const detail = blocked && state !== "signedIn" ? blocked : state === "signedIn"
    ? account?.method === "api-key" ? t("accounts.apiKey") : [account?.email, account?.organization].filter(Boolean).join(" · ") || t("accounts.signedIn")
    : state === "signedOut" ? t("accounts.notSignedIn")
    : state === "unknown" ? t("accounts.unknown")
    : instance.snapshot.reason ?? t("onboarding.engines.needsSetup");

  return (
    <li data-account={instance.instanceId} data-account-state={state} className="px-3 py-2.5">
      <div className="flex min-h-9 items-center gap-3">
        <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-full",
          state === "signedIn" ? "bg-success/15 text-success" : "bg-control text-ink-secondary")}>
          {state === "signedIn" ? <Check size={13} /> : <span className={cn("size-1.5 rounded-full", state === "signedOut" ? "bg-warning" : "bg-ink-tertiary")} />}
        </span>
        {renaming ? <RenameForm instance={instance} onDone={() => setRenaming(false)} /> : (
          <>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink" title={instance.displayName}>{instance.displayName}</div>
              <div className="truncate text-[12px] text-ink-secondary" title={detail}>{detail}</div>
            </div>
            {state !== "signedIn" && state !== "unavailable" && !blocked && !signingIn && (
              <button type="button" onClick={onSignIn} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-semibold",
                state === "signedOut" ? "bg-accent text-white hover:brightness-110" : "bg-control text-ink hover:bg-raised-hover")}>
                {t("accounts.signIn")}
              </button>
            )}
            <AccountMenu group={group} instance={instance} onRename={() => setRenaming(true)} />
          </>
        )}
      </div>
      {signingIn && (
        <div className="pl-9">
          {group === "claude"
            ? <>
              <ClaudeSignIn instanceId={instance.instanceId} autoStart onDone={onSignInDone} />
              {instance.claudeAccount?.signInCommand && (
                <details className="mt-2 text-[12px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">{t("engineSetup.preferTerminal")}</summary>
                  <CommandRow command={instance.claudeAccount.signInCommand} actionLabel={t("engineSetup.openSignIn")} compact />
                </details>
              )}
            </>
            : <DeviceSignIn instanceId={instance.instanceId} provider="codex" browserPkce={instance.authentication?.method === "browser-pkce"} autoStart onDone={onSignInDone} />}
        </div>
      )}
      {group === "chatgpt" && state === "signedIn" && instance.snapshot.chatgptPlan && (
        <div className="pl-9"><ChatGptPlanStatus instanceId={instance.instanceId} welcome={false} /></div>
      )}
    </li>
  );
}

/** Names a new account and hands its id back, so the caller can start its sign-in at once. */
export function AddAccount({ label, endpoint, extra, folder: offerFolder = false, onAdded }: {
  label: string;
  endpoint: string;
  extra?: Record<string, unknown>;
  folder?: boolean;
  onAdded: (instanceId: string) => void;
}) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (saving || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const body = { displayName: name.trim(), ...extra, ...(offerFolder && folder.trim() ? { configDir: folder.trim() } : {}) };
      const created = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      if (Array.isArray(created.instances)) dispatch({ type: "instances", instances: created.instances });
      setOpen(false);
      setName("");
      setFolder("");
      if (typeof created.instanceId === "string") onAdded(created.instanceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex min-h-8 w-fit items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
        <Plus size={14} />{label}
      </button>
    );
  }
  return (
    <form data-add-account={endpoint} className="space-y-2.5 rounded-xl border border-hairline/50 bg-app p-3" onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <label className="flex flex-col gap-1 text-[12px] font-medium text-ink">
        {t("accounts.nameLabel")}
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("accounts.namePlaceholder")} maxLength={80} autoFocus required disabled={saving}
          className="rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-normal text-ink outline-none focus:border-accent-border disabled:opacity-50" />
      </label>
      {offerFolder && (
        <details className="text-[12px] text-ink-secondary">
          <summary className="cursor-pointer select-none hover:text-ink">{t("accounts.folderToggle")}</summary>
          <input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="~/.claude-work" maxLength={4096} spellCheck={false} disabled={saving}
            aria-label={t("accounts.folderToggle")}
            className="mt-2 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-border disabled:opacity-50" />
          <p className="mt-1 leading-relaxed">{t("accounts.folderHint")}</p>
        </details>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => { setOpen(false); setError(null); }} disabled={saving} className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-control disabled:opacity-50">{t("common.cancel")}</button>
        <button type="submit" disabled={saving || !name.trim()} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
          {saving && <Loader2 size={13} className="animate-spin" />}{t("accounts.addSubmit")}
        </button>
      </div>
    </form>
  );
}

/** One card for a provider's accounts: who is signed in, one button for whoever is not, and one way to add another. */
export function AccountsCard({ group, accounts, advanced, bare = false }: { group: AccountGroup; accounts: InstanceInfo[]; advanced?: ReactNode; bare?: boolean }) {
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const primary = accounts[0]!;
  const installed = accounts.some((instance) => instance.snapshot.state === "available");
  const policy = accounts.find((instance) => instance.policy)?.policy;
  return (
    <EngineCard instance={primary} summary={summaryFor(group, accounts)} bare={bare}>
      {policy && <p className="mb-3 text-[12px] leading-relaxed text-ink-secondary">
        <span className="font-medium text-ink">{t("policy.managedBy", { organization: policy.organizationName })}</span> · {policy.reason}
      </p>}
      {!installed ? <EngineSetup instance={primary} unframed /> : (
        <div className="space-y-2">
          <ul data-accounts={group} className="divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel/40">
            {accounts.map((instance) => (
              <AccountRow key={instance.instanceId} group={group} instance={instance}
                signingIn={signingIn === instance.instanceId}
                onSignIn={() => setSigningIn(instance.instanceId)}
                onSignInDone={() => setSigningIn((current) => current === instance.instanceId ? null : current)} />
            ))}
          </ul>
          {!primary.snapshot.authenticationUnavailableReason && <AddAccount label={t(COPY[group].add)} endpoint={`/api/instances/${group}-accounts`} folder={group === "claude"} onAdded={setSigningIn} />}
        </div>
      )}
      {primary.snapshot.update && <EngineUpdateNotice update={primary.snapshot.update} instance={primary} className="mt-3" quiet />}
      {primary.snapshot.warning && <EngineWarningNotice warning={primary.snapshot.warning} className="mt-3" />}
      {advanced}
    </EngineCard>
  );
}
