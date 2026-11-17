import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { BITWARDEN_SERVERS, type BitwardenStatus } from "../../shared/logins";
import { t } from "@/lib/i18n";
import { connectBitwarden, disconnectBitwarden, refreshBitwarden } from "@/lib/logins";
import { Select } from "./Select";
import { SETTINGS_INPUT, SettingsField } from "./SettingsPrimitives";
import { SettingsDialog } from "./settings/SettingsDialog";

// Security: the API key and master password are typed here once and never come back; the form forgets them once sent.

const SELF_HOSTED = "self-hosted";

/** Bitwarden in Settings → Vault, beside 1Password: one row with its state, and a small dialog to connect it. */
export function BitwardenConnection({ status, disabled, team, onChange }: {
  status: BitwardenStatus;
  disabled: boolean;
  /** On a Team Cloud an admin connects it for the whole team. */
  team: boolean;
  onChange: (status: BitwardenStatus) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<string>(BITWARDEN_SERVERS[0]);
  const [ownServer, setOwnServer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const forget = () => { setClientId(""); setClientSecret(""); setPassword(""); };
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<BitwardenStatus>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try { await onChange(await work()); if (kind === "connect") { forget(); setOpen(false); } }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.vault.bitwarden.error")); }
    finally { setBusy(null); }
  };
  const serverUrl = server === SELF_HOSTED ? ownServer.trim() : server;
  const ready = Boolean(serverUrl && clientId.trim() && clientSecret.trim() && password);
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void run("connect", () => connectBitwarden({ serverUrl, clientId: clientId.trim(), clientSecret: clientSecret.trim(), password }));
  };
  const line = status.connected
    ? t("settings.vault.bitwarden.connected", { account: status.account ?? status.server ?? "Bitwarden", count: String(status.items ?? 0) })
    : t("settings.vault.bitwarden.line");
  return (
    <section className="flex flex-col gap-2 px-4 py-3" aria-label={t("settings.vault.bitwarden.title")} data-bitwarden>
      <div className="flex items-center gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] leading-5 text-ink">{t("settings.vault.bitwarden.title")}</span>
          <span className="text-[13px] leading-[18px] text-ink-secondary" data-bitwarden-line>{line}</span>
        </div>
        {status.connected ? <>
          <button type="button" className="settings-quiet cursor-pointer" disabled={disabled || busy !== null} onClick={() => void run("refresh", refreshBitwarden)}>{t("settings.logins.onePassword.refresh")}</button>
          <button type="button" className="ui-button" disabled={disabled || busy !== null} aria-label={t("settings.vault.bitwarden.disconnect")}
            onClick={() => void run("disconnect", disconnectBitwarden)}>{t("settings.logins.onePassword.disconnect")}</button>
        </> : <button type="button" className="ui-button" disabled={disabled} onClick={() => setOpen(true)}>{t("settings.vault.bitwarden.connect")}</button>}
      </div>
      {team && <p className="text-[12px] leading-4 text-ink-tertiary" data-bitwarden-team>{t("settings.vault.bitwarden.team")}</p>}
      {status.connected && status.error && <p role="alert" className="text-[12px] leading-4 text-danger">{status.error}</p>}
      {error && !open && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      {open && !status.connected && (
        <SettingsDialog title={t("settings.vault.bitwarden.connect")} onClose={() => { forget(); setOpen(false); }}
          footer={<>
            <button type="button" className="ui-button" onClick={() => { forget(); setOpen(false); }}>{t("common.cancel")}</button>
            <button type="submit" form="bitwarden-connect" className="ui-button ui-button-primary gap-1.5" disabled={disabled || busy !== null || !ready}>
              {busy === "connect" && <Loader2 size={13} className="animate-spin" />}{t("settings.vault.bitwarden.connect")}
            </button>
          </>}>
          <form id="bitwarden-connect" className="flex flex-col gap-3" onSubmit={connect}>
            <p className="text-[13px] leading-[18px] text-ink-secondary" data-bitwarden-guide>{t("settings.vault.bitwarden.guide")}</p>
            <SettingsField label={t("settings.vault.bitwarden.server")}>
              <Select name="bitwardenServer" value={server} onChange={(event) => setServer(event.target.value)} disabled={busy !== null}>
                <option value={BITWARDEN_SERVERS[0]}>bitwarden.com</option>
                <option value={BITWARDEN_SERVERS[1]}>bitwarden.eu</option>
                <option value={SELF_HOSTED}>{t("settings.vault.bitwarden.selfHosted")}</option>
              </Select>
            </SettingsField>
            {server === SELF_HOSTED && (
              <SettingsField label={t("settings.vault.bitwarden.address")}>
                <input name="bitwardenServerUrl" type="url" autoComplete="off" spellCheck={false} placeholder="https://vault.example.com" maxLength={2048}
                  value={ownServer} onChange={(event) => setOwnServer(event.target.value)} disabled={busy !== null} className={SETTINGS_INPUT} />
              </SettingsField>
            )}
            <SettingsField label="client_id">
              <input name="bitwardenClientId" type="text" autoComplete="off" spellCheck={false} maxLength={200} value={clientId}
                onChange={(event) => setClientId(event.target.value)} disabled={busy !== null} className={SETTINGS_INPUT} />
            </SettingsField>
            <SettingsField label="client_secret">
              <input name="bitwardenClientSecret" type="password" autoComplete="off" spellCheck={false} maxLength={256} value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)} disabled={busy !== null} className={SETTINGS_INPUT} />
            </SettingsField>
            <SettingsField label={t("settings.vault.bitwarden.password")} hint={t("settings.vault.bitwarden.note")}>
              <input name="bitwardenPassword" type="password" autoComplete="off" spellCheck={false} maxLength={1024} value={password}
                onChange={(event) => setPassword(event.target.value)} disabled={busy !== null} className={SETTINGS_INPUT} />
            </SettingsField>
            {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
          </form>
        </SettingsDialog>
      )}
    </section>
  );
}
