import { useEffect, useState, type FormEvent } from "react";
import { ChevronDown, KeyRound, Loader2, LockKeyhole, ShieldCheck, Trash2 } from "lucide-react";

import { loginHeldBackFor, type LoginBots, type LoginSummary, type OnePasswordStatus, type OnePasswordVault } from "../../shared/logins";
import type { LinkedSecret, VaultSecret } from "../../shared/vault";
import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { addLogin, changeLogin, connectOnePassword, deleteLogin, disconnectOnePassword, grantVault, refreshOnePassword } from "@/lib/logins";
import { relativeTime } from "@/lib/memory";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { deleteSecret, listVault } from "@/lib/vault";
import { useStore } from "@/state/store";
import { Segmented } from "./bot-panel/rows";
import { LoginBotPicker, LoginForm } from "./LoginForm";
import { Card, LearnMore, SETTINGS_INPUT, SettingsEmptyRow, SettingsField, SettingsGroup, SettingsLinkRow, SettingsRows } from "./SettingsPrimitives";
import { SettingsDialog } from "./settings/SettingsDialog";
import { EnvImportForm, SecretForm } from "./VaultSecretForms";

// Security: a row never shows a password or a secret, which no route returns. A saved value can only be replaced.

const SOURCE_KEYS = {
  card: "settings.logins.source.card",
  settings: "settings.logins.source.settings",
  "1password": "settings.logins.source.1password",
  linked: "settings.logins.source.1password",
} as const;

const ROW_BUTTON = "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

type Filter = "all" | "logins" | "secrets";
type Adding = "login" | "secret" | "env" | null;
type Row = { kind: "login"; key: string; login: LoginSummary } | { kind: "secret"; key: string; secret: VaultSecret | LinkedSecret };

const ADD_CHOICES = [["login", "settings.vault.addLogin"], ["secret", "settings.vault.addSecret"], ["env", "settings.vault.importEnv"]] as const;

function rowsOf(logins: LoginSummary[], secrets: Array<VaultSecret | LinkedSecret>, filter: Filter, query: string): Row[] {
  const q = query.trim().toLowerCase();
  const rows: Row[] = [
    ...(filter === "secrets" ? [] : logins.map((login): Row => ({ kind: "login", key: [login.site, login.username, ...login.hosts].join(" "), login }))),
    ...(filter === "logins" ? [] : secrets.map((secret): Row => ({ kind: "secret", key: secret.name, secret }))),
  ];
  return rows.filter((row) => !q || row.key.toLowerCase().includes(q)).sort((a, b) => a.key.localeCompare(b.key));
}

export function VaultSettings() {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const bots = state.bots.map((bot) => ({ id: bot.id, name: bot.name }));
  const [logins, setLogins] = useState<LoginSummary[] | null>(null);
  const [secrets, setSecrets] = useState<Array<VaultSecret | LinkedSecret>>([]);
  const [onePassword, setOnePassword] = useState<OnePasswordStatus>({ connected: false });
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [menu, setMenu] = useState(false);
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState<Adding>(null);
  const [site, setSite] = useState("");
  const [addBots, setAddBots] = useState<LoginBots>("all");
  const [addExact, setAddExact] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBots, setEditBots] = useState<LoginBots>("all");
  const [editExact, setEditExact] = useState(false);
  const [removeTotp, setRemoveTotp] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keysOff, setKeysOff] = useState<string[]>([]);

  const load = async () => {
    try {
      const answer = await listVault();
      setLogins(answer.logins ?? []);
      setSecrets(answer.secrets ?? []);
      setOnePassword(answer.onePassword ?? { connected: false });
      setError(null);
    }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.vault.loadError")); }
  };
  useEffect(() => { if (ownerOrAdmin) void load(); }, [ownerOrAdmin]);

  if (ownerOrAdmin === false) {
    return <Card title={t("settings.vault.title")} subtitle={t("settings.vault.adminOnly")} />;
  }

  const botNames = (value: LoginBots) => {
    if (value === "all") return t("settings.logins.allBots");
    const names = value.flatMap((id) => bots.find((bot) => bot.id === id)?.name ?? []);
    return names.length ? names.join(", ") : t("settings.logins.noBots");
  };
  const used = (at: number | undefined) => at ? t("settings.logins.used", { when: relativeTime(at) }) : t("settings.logins.neverUsed");
  const startEdit = (id: string, login?: LoginSummary) => {
    setAdding(null);
    setDeleting(null);
    setRemoveTotp(false);
    if (login) { setEditBots(login.bots); setEditExact(login.exactHost); }
    setEditing(id);
  };
  const startAdding = (kind: Adding) => {
    setMenu(false);
    setEditing(null);
    setDeleting(null);
    setAdding(kind);
  };
  const remove = async (id: string, kind: "login" | "secret") => {
    if (deleting !== id) { setDeleting(id); return; }
    setBusy(true);
    setKeysOff([]);
    try {
      if (kind === "login") await deleteLogin(id);
      else setKeysOff(await deleteSecret(id));
      setDeleting(null);
      await load();
    }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.deleteError")); }
    finally { setBusy(false); }
  };
  const rowButtons = (id: string, kind: "login" | "secret", name: string, onChange: () => void) => (
    <div className="flex shrink-0 gap-1">
      <button type="button" className={ROW_BUTTON} disabled={busy} onClick={onChange}
        aria-label={kind === "login" ? t("settings.logins.changeFor", { site: name }) : t("settings.vault.secret.changeFor", { name })}>{t("settings.logins.change")}</button>
      <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => void remove(id, kind)}
        aria-label={deleting === id ? t("settings.logins.deleteConfirm") : kind === "login" ? t("settings.logins.deleteFor", { site: name }) : t("settings.vault.secret.deleteFor", { name })}>
        <Trash2 size={13} />{deleting === id ? t("settings.logins.deleteConfirm") : t("settings.logins.delete")}
      </button>
    </div>
  );
  const rows = rowsOf(logins ?? [], secrets, filter, query);
  const empty = logins !== null && logins.length === 0 && secrets.length === 0;

  const loginRow = (login: LoginSummary) => (
    <li key={login.id} className="flex flex-col gap-2 py-2.5" data-login-row={login.site}>
      <div className="flex min-w-0 items-start gap-2">
        <LockKeyhole size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-ink-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span dir="ltr" className="truncate text-[13px] font-medium text-ink" title={login.site}>{login.site}</span>
            {login.hasTotp && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-ink/[0.07] px-1.5 text-[11px] text-ink-secondary">
                <ShieldCheck size={11} aria-hidden="true" />{t("settings.logins.twoFactor")}
              </span>
            )}
          </div>
          <div dir="auto" className="truncate text-[12px] text-ink-secondary">{login.username || t("settings.logins.noUsername")}</div>
          {signInHostsLine(login) && <div dir="ltr" className="truncate text-[12px] text-ink-tertiary" data-login-hosts>{signInHostsLine(login)}</div>}
          <div className="mt-0.5 text-[12px] leading-snug text-ink-tertiary">
            {[t(SOURCE_KEYS[login.source]), botNames(login.bots), used(login.lastUsedAt)].join(" · ")}
          </div>
          {loginHeldBackFor(login, state.bots).length > 0 && (
            <div className="mt-0.5 text-[12px] leading-snug text-warning" data-login-held-back>
              {t("settings.logins.sharedBrowser", { bots: botNames(loginHeldBackFor(login, state.bots)) })}
            </div>
          )}
        </div>
        {login.source !== "1password" && rowButtons(login.id, "login", login.site, () => startEdit(login.id, login))}
      </div>
      {editing === login.id && (
        <div className="ms-6 rounded-lg bg-inset/60 p-3">
          <LoginForm username={false} replacing submitLabel={t("settings.logins.saveChange")} autoFocus
            onCancel={() => setEditing(null)}
            onSubmit={async (fields) => {
              await changeLogin(login.id, { password: fields.password, totp: fields.totp, removeTotp, bots: editBots, ...(editExact === login.exactHost ? {} : { exactHost: editExact }) });
              setEditing(null);
              await load();
            }}>
            {login.hasTotp && (
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="checkbox" checked={removeTotp} onChange={(event) => setRemoveTotp(event.target.checked)} />
                {t("settings.logins.removeTotp")}
              </label>
            )}
            <ExactHostChoice checked={editExact} onChange={setEditExact}
              label={t("settings.logins.exactHostFor", { hosts: login.hosts.join(", "), site: login.site })} />
            <LoginBotPicker value={editBots} onChange={setEditBots} bots={bots} />
          </LoginForm>
        </div>
      )}
    </li>
  );

  const secretRow = (secret: VaultSecret | LinkedSecret) => (
    <li key={secret.id} className="flex flex-col gap-2 py-2.5" data-secret-row={secret.name}>
      <div className="flex min-w-0 items-start gap-2">
        <KeyRound size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-ink-tertiary" />
        <div className="min-w-0 flex-1">
          <div dir="auto" className="truncate text-[13px] font-medium text-ink" title={secret.name}>{secret.name}</div>
          <div className="mt-0.5 text-[12px] leading-snug text-ink-tertiary">
            {[t(SOURCE_KEYS[secret.source]), botNames(secret.bots), used(secret.lastUsedAt)].join(" · ")}
          </div>
        </div>
        {secret.source !== "linked" && rowButtons(secret.id, "secret", secret.name, () => startEdit(secret.id))}
      </div>
      {editing === secret.id && secret.source !== "linked" && (
        <div className="ms-6 rounded-lg bg-inset/60 p-3">
          <SecretForm secret={secret} bots={bots} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />
        </div>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-6" aria-busy={logins === null || busy} data-vault>
      <SettingsGroup label={t("settings.vault.saved")} block="saved-list"
        description={state.config?.cloudHome === true ? <span data-logins-cloud-own>{t("settings.logins.cloudOwn")}</span> : undefined}
        actions={<div className="relative">
          <button type="button" className="ui-button gap-1" disabled={logins === null} aria-expanded={menu} onClick={() => setMenu(!menu)}
            onKeyDown={(event) => { if (event.key === "Escape") setMenu(false); }}>
            {t("settings.vault.add")}<ChevronDown size={12} aria-hidden="true" />
          </button>
          {menu && (
            <div className="popover-surface absolute end-0 top-full z-10 mt-1 flex min-w-[11rem] flex-col rounded-[12px] p-1" data-vault-add>
              {ADD_CHOICES.map(([kind, key]) => (
                <button key={kind} type="button" className="h-8 rounded-lg px-2 text-start text-[14px] leading-5 text-ink hover:bg-menu-hover" onClick={() => startAdding(kind)}>{t(key)}</button>
              ))}
            </div>
          )}
        </div>}
        footnote={<>{t("settings.vault.limitsShort")}{" "}<LearnMore onClick={() => setMore((open) => !open)} />{more && <span className="mt-1 block">{t("settings.logins.limits")}</span>}</>}>
        {!empty && (
          <div className="flex flex-wrap items-center gap-3 px-4">
            <Segmented label={t("settings.vault.filter")} attr="data-vault-filter" value={filter} onChange={setFilter}
              options={[{ value: "all", label: t("settings.vault.filter.all") }, { value: "logins", label: t("settings.vault.filter.logins") }, { value: "secrets", label: t("settings.vault.filter.secrets") }]} />
            <input data-vault-search type="text" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" spellCheck={false}
              placeholder={t("settings.vault.search")} aria-label={t("settings.vault.search")} className={`${SETTINGS_INPUT} ms-auto h-7 max-w-[200px]`} />
          </div>
        )}
        <SettingsRows>
          {adding === "login" && (
            <div className="p-4">
              <LoginForm site={{ value: site, onChange: setSite }} submitLabel={t("settings.logins.save")} autoFocus
                onCancel={() => setAdding(null)}
                onSubmit={async (fields) => {
                  await addLogin(site, fields, addBots, addExact);
                  setAdding(null);
                  setSite("");
                  setAddBots("all");
                  setAddExact(false);
                  await load();
                }}>
                <ExactHostChoice checked={addExact} onChange={setAddExact} label={t("settings.logins.exactHost")} />
                <LoginBotPicker value={addBots} onChange={setAddBots} bots={bots} />
              </LoginForm>
            </div>
          )}
          {adding === "secret" && <div className="p-4"><SecretForm bots={bots} onCancel={() => setAdding(null)} onSaved={async () => { setAdding(null); await load(); }} /></div>}
          {adding === "env" && <div className="p-4"><EnvImportForm bots={bots} onCancel={() => setAdding(null)} onSaved={load} /></div>}
          {logins === null && !error && <SettingsEmptyRow>{t("settings.vault.loading")}</SettingsEmptyRow>}
          {empty && !adding && <SettingsEmptyRow>{t("settings.vault.emptyShort")}</SettingsEmptyRow>}
          {!empty && logins !== null && rows.length === 0 && <div data-vault-none className="contents"><SettingsEmptyRow>{t("settings.vault.noMatch")}</SettingsEmptyRow></div>}
          {rows.length > 0 && (
            <ul className="divide-y-[0.5px] divide-(--settings-edge) px-4" data-logins-list>
              {rows.map((row) => row.kind === "login" ? loginRow(row.login) : secretRow(row.secret))}
            </ul>
          )}
        </SettingsRows>
        {keysOff.length > 0 && <p role="status" className="px-4 text-[12px] leading-4 text-warning" data-vault-keys-off>{t("settings.vault.secret.keyOff", { servers: keysOff.join(", ") })}</p>}
        {error && <p role="alert" className="px-4 text-[12px] leading-4 text-danger">{error}</p>}
      </SettingsGroup>
      <SettingsGroup label={t("settings.vault.elsewhere")} block="vault-more">
        <SettingsRows>
          <div data-vault-keys className="contents">
            <SettingsLinkRow title={t("settings.vault.keys.title")} subtitle={t("settings.vault.keys.hintShort", { app: productName() })} onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })} />
          </div>
          <OnePasswordConnection status={onePassword} disabled={logins === null} bots={bots} botNames={botNames}
            onChange={async (next) => { setOnePassword(next); await load(); }} />
        </SettingsRows>
      </SettingsGroup>
    </div>
  );
}

/** Where a login signs in beyond its site's own pages, or that it is kept to those hosts. */
function signInHostsLine(login: LoginSummary): string | null {
  if (login.exactHost) return t("settings.logins.onlyOn", { hosts: login.hosts.join(", ") });
  const elsewhere = login.hosts.filter((host) => host !== login.site);
  return elsewhere.length ? t("settings.logins.signsInOn", { hosts: elsewhere.join(", ") }) : null;
}

function ExactHostChoice({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex items-start gap-2 text-[13px] leading-snug text-ink">
      <input type="checkbox" name="exactHost" className="mt-[2px]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function VaultAccess({ vault, bots, botNames, disabled, onChange }: {
  vault: OnePasswordVault;
  bots: ReadonlyArray<{ id: string; name: string }>;
  botNames: (value: LoginBots) => string;
  disabled: boolean;
  onChange: (status: OnePasswordStatus) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<LoginBots>(vault.bots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try { await onChange(await grantVault(vault.id, value)); setEditing(false); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.onePassword.error")); }
    finally { setBusy(false); }
  };
  return (
    <li className="flex flex-col gap-2 py-2" data-vault={vault.title}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{vault.title}</div>
          <div className="text-[12px] text-ink-tertiary">{t("settings.logins.onePassword.vaultUse", { count: String(vault.items), who: botNames(vault.bots) })}</div>
        </div>
        {!editing && (
          <button type="button" className={ROW_BUTTON} disabled={disabled || busy} onClick={() => { setValue(vault.bots); setEditing(true); }}
            aria-label={t("settings.logins.onePassword.changeVault", { vault: vault.title })}>{t("settings.logins.change")}</button>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-2 rounded-lg bg-inset/60 p-3">
          <LoginBotPicker value={value} onChange={setValue} bots={bots} disabled={busy} />
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="ui-button ui-button-md" disabled={busy} onClick={() => setEditing(false)}>{t("logins.cancel")}</button>
            <button type="button" className="ui-button ui-button-md ui-button-primary" disabled={busy} onClick={() => void save()}>{t("settings.logins.saveChange")}</button>
          </div>
        </div>
      )}
    </li>
  );
}

function OnePasswordConnection({ status, disabled, bots, botNames, onChange }: {
  status: OnePasswordStatus;
  disabled: boolean;
  bots: ReadonlyArray<{ id: string; name: string }>;
  botNames: (value: LoginBots) => string;
  onChange: (status: OnePasswordStatus) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<OnePasswordStatus>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try { await onChange(await work()); if (kind === "connect") { setToken(""); setOpen(false); } }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.onePassword.error")); }
    finally { setBusy(null); }
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) void run("connect", () => connectOnePassword(token.trim()));
  };
  return (
    <section className="flex flex-col gap-2 px-4 py-3" aria-label={t("settings.vault.manager")} data-onepassword>
      <div className="flex items-center gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] leading-5 text-ink">{t("settings.vault.connectManager")}</span>
          <span className="text-[13px] leading-[18px] text-ink-secondary">{status.connected
            ? t("settings.logins.onePassword.connected", { vaults: (status.vaults ?? []).map((vault) => vault.title).join(", ") || "—", count: String(status.items ?? 0) })
            : t("settings.vault.managerLine")}</span>
        </div>
        {status.connected ? <>
          <button type="button" className="settings-quiet cursor-pointer" disabled={disabled || busy !== null} onClick={() => void run("refresh", refreshOnePassword)}>{t("settings.logins.onePassword.refresh")}</button>
          <button type="button" className="ui-button" disabled={disabled || busy !== null} onClick={() => void run("disconnect", disconnectOnePassword)}>{t("settings.logins.onePassword.disconnect")}</button>
        </> : <button type="button" className="ui-button" disabled={disabled} onClick={() => setOpen(true)}>{t("settings.logins.onePassword.connect")}</button>}
      </div>
      {status.connected && status.error && <p role="alert" className="text-[12px] leading-4 text-danger">{status.error}</p>}
      {status.connected && !!status.vaults?.length && (
        <ul className="divide-y-[0.5px] divide-(--settings-edge)" aria-label={t("settings.logins.onePassword.vaults")}>
          {status.vaults.map((vault) => <VaultAccess key={vault.id} vault={vault} bots={bots} botNames={botNames} disabled={disabled} onChange={onChange} />)}
        </ul>
      )}
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      {open && !status.connected && (
        <SettingsDialog title={t("settings.vault.connectManager")} onClose={() => setOpen(false)}
          footer={<>
            <button type="button" className="ui-button" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
            <button type="submit" form="onepassword-connect" className="ui-button ui-button-primary gap-1.5" disabled={disabled || busy !== null || !token.trim()}>
              {busy === "connect" && <Loader2 size={13} className="animate-spin" />}{t("settings.logins.onePassword.connect")}
            </button>
          </>}>
          <form id="onepassword-connect" className="flex flex-col gap-3" onSubmit={(event) => { connect(event); }}>
            <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.logins.onePassword.guide")}</p>
            <SettingsField label={t("settings.logins.onePassword.token")} hint={t("settings.logins.onePassword.note")}>
              <input name="onePasswordToken" type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={token}
                onChange={(event) => setToken(event.target.value)} disabled={disabled || busy !== null} className={SETTINGS_INPUT} />
            </SettingsField>
          </form>
        </SettingsDialog>
      )}
    </section>
  );
}
