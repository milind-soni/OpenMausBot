import { useEffect, useState, type FormEvent } from "react";
import { ChevronDown, KeyRound, Loader2, LockKeyhole, ShieldCheck, Trash2 } from "lucide-react";

import { loginHeldBackFor, type BitwardenStatus, type LoginBots, type LoginSummary, type OnePasswordItemRef, type OnePasswordStatus, type OnePasswordVault } from "../../shared/logins";
import type { LinkedSecret, VaultSecret } from "../../shared/vault";
import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { addLogin, changeLogin, connectBitwarden, connectOnePassword, deleteLogin, disconnectBitwarden, disconnectOnePassword, grantBitwarden, grantBitwardenItem, grantOnePasswordItem, grantVault, refreshBitwarden, refreshOnePassword, type BitwardenAccountInput } from "@/lib/logins";
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
  bitwarden: "settings.logins.source.bitwarden",
} as const;

/** A login or secret read from a password manager: its item there, and the words for choosing its bots. */
type ItemLink = { ref: OnePasswordItemRef; provider: "1password" | "bitwarden" };
const ITEM_WORDS = {
  "1password": { parent: "settings.logins.onePassword.vaultChoice", note: "settings.logins.onePassword.itemNote", back: "settings.logins.onePassword.useVaultChoice", error: "settings.logins.onePassword.error", grant: grantOnePasswordItem },
  bitwarden: { parent: "settings.logins.bitwarden.accountChoice", note: "settings.logins.bitwarden.itemNote", back: "settings.logins.bitwarden.useAccountChoice", error: "settings.logins.bitwarden.error", grant: grantBitwardenItem },
} as const;
const linkOf = (row: { onePassword?: OnePasswordItemRef; bitwarden?: OnePasswordItemRef }): ItemLink | undefined =>
  row.onePassword ? { ref: row.onePassword, provider: "1password" } : row.bitwarden ? { ref: row.bitwarden, provider: "bitwarden" } : undefined;

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
  const member = ownerOrAdmin === false && Boolean(state.config?.team);
  const bots = state.bots.map((bot) => ({ id: bot.id, name: bot.name }));
  const [logins, setLogins] = useState<LoginSummary[] | null>(null);
  const [secrets, setSecrets] = useState<Array<VaultSecret | LinkedSecret>>([]);
  const [onePassword, setOnePassword] = useState<OnePasswordStatus>({ connected: false });
  const [bitwarden, setBitwarden] = useState<BitwardenStatus | null>(null);
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
      setBitwarden(answer.bitwarden ?? null);
      setError(null);
    }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.vault.loadError")); }
  };
  useEffect(() => { if (ownerOrAdmin || member) void load(); }, [ownerOrAdmin, member]);

  if (ownerOrAdmin === false && !member) {
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
      {!member && <button type="button" className={ROW_BUTTON} disabled={busy} onClick={onChange}
        aria-label={kind === "login" ? t("settings.logins.changeFor", { site: name }) : t("settings.vault.secret.changeFor", { name })}>{t("settings.logins.change")}</button>}
      <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => void remove(id, kind)}
        aria-label={deleting === id ? t("settings.logins.deleteConfirm") : kind === "login" ? t("settings.logins.deleteFor", { site: name }) : t("settings.vault.secret.deleteFor", { name })}>
        <Trash2 size={13} />{deleting === id ? t("settings.logins.deleteConfirm") : t("settings.logins.delete")}
      </button>
    </div>
  );
  /** An item without bots of its own follows its 1Password vault or Bitwarden account: say so, since changing that changes it. */
  const whoLine = (value: LoginBots, link?: ItemLink) =>
    link && !link.ref.ownBots ? t(ITEM_WORDS[link.provider].parent, { who: botNames(value) }) : botNames(value);
  const itemButton = (id: string, name: string) => !member && editing !== id && (
    <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => startEdit(id)}
      aria-label={t("settings.logins.onePassword.changeItem", { name })}>{t("settings.logins.change")}</button>
  );
  const itemEditor = (link: ItemLink, value: LoginBots) => (
    <ItemAccess link={link} value={value} bots={bots} onCancel={() => setEditing(null)}
      onSaved={async () => { setEditing(null); await load(); }} />
  );
  const rows = rowsOf(logins ?? [], secrets, filter, query);
  const empty = logins !== null && logins.length === 0 && secrets.length === 0;

  /** A password manager's login is changed there: here only its bots can be chosen. */
  const loginRow = (login: LoginSummary, link = linkOf(login), managed = login.source === "1password" || login.source === "bitwarden") => (
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
            {[t(SOURCE_KEYS[login.source]), whoLine(login.bots, link), used(login.lastUsedAt)].join(" · ")}
          </div>
          {loginHeldBackFor(login, state.bots).length > 0 && (
            <div className="mt-0.5 text-[12px] leading-snug text-warning" data-login-held-back>
              {t("settings.logins.sharedBrowser", { bots: botNames(loginHeldBackFor(login, state.bots)) })}
            </div>
          )}
        </div>
        {!managed && rowButtons(login.id, "login", login.site, () => startEdit(login.id, login))}
        {link && itemButton(login.id, login.site)}
      </div>
      {editing === login.id && link && itemEditor(link, login.bots)}
      {editing === login.id && !managed && (
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

  const secretRow = (secret: VaultSecret | LinkedSecret, link = secret.source === "linked" ? linkOf(secret) : undefined) => (
    <li key={secret.id} className="flex flex-col gap-2 py-2.5" data-secret-row={secret.name}>
      <div className="flex min-w-0 items-start gap-2">
        <KeyRound size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-ink-tertiary" />
        <div className="min-w-0 flex-1">
          <div dir="auto" className="truncate text-[13px] font-medium text-ink" title={secret.name}>{secret.name}</div>
          <div className="mt-0.5 text-[12px] leading-snug text-ink-tertiary">
            {[t(link ? SOURCE_KEYS[link.provider] : SOURCE_KEYS[secret.source]), whoLine(secret.bots, link), used(secret.lastUsedAt)].join(" · ")}
          </div>
        </div>
        {secret.source !== "linked" && rowButtons(secret.id, "secret", secret.name, () => startEdit(secret.id))}
        {link && itemButton(secret.id, secret.name)}
      </div>
      {editing === secret.id && link && itemEditor(link, secret.bots)}
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
        description={member ? t("settings.vault.memberSubtitle") : state.config?.cloudHome === true ? <span data-logins-cloud-own>{t("settings.logins.cloudOwn")}</span> : undefined}
        actions={member ? undefined : <div className="relative">
          <button type="button" className="ui-button gap-1" disabled={logins === null} aria-expanded={menu} onClick={() => setMenu(!menu)}
            onKeyDown={(event) => { if (event.key === "Escape") setMenu(false); }}>
            {t("settings.vault.add")}<ChevronDown size={12} aria-hidden="true" />
          </button>
          {menu && (
            <div className="popover-surface absolute end-0 top-full z-10 mt-1 flex min-w-[11rem] flex-col rounded-[12px] p-1" data-vault-add data-look="popover">
              {ADD_CHOICES.map(([kind, key]) => (
                <button key={kind} type="button" className="h-8 rounded-lg px-2 text-start text-[14px] leading-5 text-ink hover:bg-menu-hover" onClick={() => startAdding(kind)}>{t(key)}</button>
              ))}
            </div>
          )}
        </div>}
        footnote={member ? undefined : <>{t("settings.vault.limitsShort")}{" "}<LearnMore onClick={() => setMore((open) => !open)} />{more && <span className="mt-1 block">{t("settings.logins.limits")}</span>}</>}>
        {!empty && (
          <div className="flex flex-wrap items-center gap-3 px-4">
            {!member && <Segmented label={t("settings.vault.filter")} attr="data-vault-filter" value={filter} onChange={setFilter}
              options={[{ value: "all", label: t("settings.vault.filter.all") }, { value: "logins", label: t("settings.vault.filter.logins") }, { value: "secrets", label: t("settings.vault.filter.secrets") }]} />}
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
          {empty && !adding && <SettingsEmptyRow>{t(member ? "settings.vault.memberEmpty" : "settings.vault.emptyShort")}</SettingsEmptyRow>}
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
      {!member && <SettingsGroup label={t("settings.vault.elsewhere")} block="vault-more">
        <SettingsRows>
          <div data-vault-keys className="contents">
            <SettingsLinkRow title={t("settings.vault.keys.title")} subtitle={t("settings.vault.keys.hintShort", { app: productName() })} onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })} />
          </div>
          <OnePasswordConnection status={onePassword} disabled={logins === null} bots={bots} botNames={botNames}
            onChange={async (next) => { setOnePassword(next); await load(); }} />
          {bitwarden && <BitwardenConnection status={bitwarden} disabled={logins === null} bots={bots} botNames={botNames}
            onChange={async (next) => { setBitwarden(next); await load(); }} />}
        </SettingsRows>
      </SettingsGroup>}
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

/** Which bots may use one 1Password or Bitwarden item, ahead of its vault's or account's choice; the hand-back button
 * returns it to that choice. */
function ItemAccess({ link, value: initial, bots, onCancel, onSaved }: {
  link: ItemLink;
  value: LoginBots;
  bots: ReadonlyArray<{ id: string; name: string }>;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState<LoginBots>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const words = ITEM_WORDS[link.provider];
  const save = async (next: LoginBots | null) => {
    setBusy(true);
    setError(null);
    try { await words.grant(link.ref.item, next); await onSaved(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t(words.error)); }
    finally { setBusy(false); }
  };
  return (
    <div className="ms-6 flex flex-col gap-2 rounded-lg bg-inset/60 p-3" {...{ [`data-${link.provider === "1password" ? "onepassword" : "bitwarden"}-item`]: link.ref.item }}>
      <LoginBotPicker value={value} onChange={setValue} bots={bots} disabled={busy} />
      <p className="text-[12px] text-ink-tertiary">{t(words.note)}</p>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {link.ref.ownBots && (
          <button type="button" className="ui-button ui-button-md" disabled={busy} onClick={() => void save(null)}>{t(words.back)}</button>
        )}
        <button type="button" className="ui-button ui-button-md" disabled={busy} onClick={onCancel}>{t("logins.cancel")}</button>
        <button type="button" className="ui-button ui-button-md ui-button-primary" disabled={busy} onClick={() => void save(value)}>{t("settings.logins.saveChange")}</button>
      </div>
    </div>
  );
}

/** Which bots may use a whole 1Password vault or Bitwarden account. */
function AccessRow({ title, line, changeLabel, value: current, bots, disabled, errorText, save: grant, attrs }: {
  title: string;
  line: string;
  changeLabel: string;
  value: LoginBots;
  bots: ReadonlyArray<{ id: string; name: string }>;
  disabled: boolean;
  errorText: string;
  save: (bots: LoginBots) => Promise<void>;
  attrs: Record<string, string>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<LoginBots>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try { await grant(value); setEditing(false); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : errorText); }
    finally { setBusy(false); }
  };
  return (
    <li className="flex flex-col gap-2 py-2" {...attrs}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div dir="auto" className="truncate text-[13px] font-medium text-ink">{title}</div>
          <div className="text-[12px] text-ink-tertiary">{line}</div>
        </div>
        {!editing && (
          <button type="button" className={ROW_BUTTON} disabled={disabled || busy} onClick={() => { setValue(current); setEditing(true); }}
            aria-label={changeLabel}>{t("settings.logins.change")}</button>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-2 rounded-lg bg-inset/60 p-3">
          <LoginBotPicker value={value} onChange={setValue} bots={bots} disabled={busy} />
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="ui-button ui-button-md" disabled={busy} onClick={() => setEditing(false)}>{t("logins.cancel")}</button>
            <button type="button" className="ui-button ui-button-md ui-button-primary" disabled={disabled || busy} onClick={() => void save()}>{t("settings.logins.saveChange")}</button>
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
          {status.vaults.map((vault: OnePasswordVault) => (
            <AccessRow key={vault.id} title={vault.title} value={vault.bots} bots={bots} disabled={disabled} attrs={{ "data-vault": vault.title }}
              line={t("settings.logins.onePassword.vaultUse", { count: String(vault.items), who: botNames(vault.bots) })}
              changeLabel={t("settings.logins.onePassword.changeVault", { vault: vault.title })} errorText={t("settings.logins.onePassword.error")}
              save={async (next) => { await onChange(await grantVault(vault.id, next)); }} />
          ))}
        </ul>
      )}
      {error && !open && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
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
            {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
          </form>
        </SettingsDialog>
      )}
    </section>
  );
}

const BITWARDEN_FORM: BitwardenAccountInput = { server: "https://vault.bitwarden.com", clientId: "", clientSecret: "", password: "" };
const BITWARDEN_FIELDS = [
  ["server", "bitwardenServer", "text", "settings.logins.bitwarden.server"],
  ["clientId", "bitwardenClientId", "text", "settings.logins.bitwarden.clientId"],
  ["clientSecret", "bitwardenClientSecret", "password", "settings.logins.bitwarden.clientSecret"],
  ["password", "bitwardenPassword", "password", "settings.logins.bitwarden.password"],
] as const;

/** Bitwarden or a self-hosted Vaultwarden, read with the person's API key and master password; what it holds is
 * listed above, read-only, for the bots chosen here. */
function BitwardenConnection({ status, disabled, bots, botNames, onChange }: {
  status: BitwardenStatus;
  disabled: boolean;
  bots: ReadonlyArray<{ id: string; name: string }>;
  botNames: (value: LoginBots) => string;
  onChange: (status: BitwardenStatus) => Promise<void>;
}) {
  const [form, setForm] = useState<BitwardenAccountInput>(BITWARDEN_FORM);
  const [open, setOpen] = useState(false);
  // One action at a time across the card, so a slow save of the bots can't bring back a status Disconnect just cleared.
  const [busy, setBusy] = useState<"connect" | "refresh" | "disconnect" | "grant" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setOpen(false); setForm(BITWARDEN_FORM); setError(null); };
  // A check under way can't be called back, so the dialog stays until it ends.
  const close = () => { if (busy !== "connect") reset(); };
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<BitwardenStatus>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try { await onChange(await work()); if (kind === "connect") reset(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.bitwarden.error")); }
    finally { setBusy(null); }
  };
  const grant = async (next: LoginBots) => {
    setBusy("grant");
    try { await onChange(await grantBitwarden(next)); }
    finally { setBusy(null); }
  };
  const ready = form.clientId.trim() && form.clientSecret.trim() && form.password;
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void run("connect", () => connectBitwarden({ ...form, server: form.server.trim(), clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() }));
  };
  const server = status.server?.replace(/^https:\/\//u, "") ?? "";
  return (
    <section className="flex flex-col gap-2 px-4 py-3" aria-label={t("settings.logins.bitwarden.title")} data-bitwarden>
      <div className="flex items-center gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] leading-5 text-ink">{t("settings.logins.bitwarden.title")}</span>
          <span className="text-[13px] leading-[18px] text-ink-secondary">{status.connected
            ? t("settings.logins.bitwarden.connected", { server })
            : t("settings.logins.bitwarden.line")}</span>
        </div>
        {status.connected ? <>
          <button type="button" className="settings-quiet cursor-pointer" disabled={disabled || busy !== null} onClick={() => void run("refresh", refreshBitwarden)}
            aria-label={t("settings.logins.bitwarden.refresh")}>{t("settings.logins.onePassword.refresh")}</button>
          <button type="button" className="ui-button" disabled={disabled || busy !== null} onClick={() => void run("disconnect", disconnectBitwarden)}
            aria-label={t("settings.logins.bitwarden.disconnect")}>{t("settings.logins.onePassword.disconnect")}</button>
        </> : <button type="button" className="ui-button" disabled={disabled} onClick={() => setOpen(true)}>{t("settings.logins.bitwarden.connect")}</button>}
      </div>
      {status.connected && status.error && <p role="alert" className="text-[12px] leading-4 text-danger">{status.error}</p>}
      {status.connected && (
        <ul className="divide-y-[0.5px] divide-(--settings-edge)">
          <AccessRow title={t("settings.logins.bitwarden.account")} value={status.bots ?? "all"} bots={bots} disabled={disabled || busy !== null} attrs={{ "data-bitwarden-account": server }}
            line={t("settings.logins.bitwarden.accountUse", { count: String(status.items ?? 0), who: botNames(status.bots ?? "all") })}
            changeLabel={t("settings.logins.bitwarden.changeAccount")} errorText={t("settings.logins.bitwarden.error")}
            save={grant} />
        </ul>
      )}
      {error && !open && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      {open && !status.connected && (
        <SettingsDialog title={t("settings.logins.bitwarden.connect")} onClose={close}
          footer={<>
            <button type="button" className="ui-button" disabled={busy === "connect"} onClick={close}>{t("common.cancel")}</button>
            <button type="submit" form="bitwarden-connect" className="ui-button ui-button-primary gap-1.5" disabled={disabled || busy !== null || !ready}>
              {busy === "connect" && <Loader2 size={13} className="animate-spin" />}{t("settings.logins.bitwarden.connect")}
            </button>
          </>}>
          <form id="bitwarden-connect" className="flex flex-col gap-3" onSubmit={connect}>
            <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.logins.bitwarden.guide", { app: productName() })}</p>
            {BITWARDEN_FIELDS.map(([key, name, type, label]) => (
              <SettingsField key={key} label={t(label)} hint={key === "server" ? t("settings.logins.bitwarden.serverHint") : undefined}>
                <input name={name} type={type} dir="ltr" autoComplete="off" spellCheck={false} maxLength={1024} value={form[key]}
                  onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} disabled={disabled || busy !== null} className={SETTINGS_INPUT} />
              </SettingsField>
            ))}
            <p className="text-[12px] leading-4 text-ink-secondary">{t("settings.logins.bitwarden.note", { app: productName() })}</p>
            {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
          </form>
        </SettingsDialog>
      )}
    </section>
  );
}
