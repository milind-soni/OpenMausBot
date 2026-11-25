import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";

import { BITWARDEN_SERVERS, type BitwardenSecretsStatus } from "../../shared/logins";
import { t } from "@/lib/i18n";
import { connectBitwardenSecrets, disconnectBitwardenSecrets, refreshBitwardenSecrets } from "@/lib/logins";
import { Select } from "./Select";
import { SETTINGS_INPUT, SettingsField } from "./SettingsPrimitives";
import { SettingsDialog } from "./settings/SettingsDialog";

// Security: the access token is typed here once and never comes back; the form forgets it once sent.

const SELF_HOSTED = "self-hosted";

/** Bitwarden Secrets Manager in Settings → Vault, under Bitwarden: one row with its state, and a small dialog to connect it. */
export function BitwardenSecretsConnection({ status, disabled, team, onChange }: {
  status: BitwardenSecretsStatus;
  disabled: boolean;
  /** On a Team Cloud an admin connects it for the whole team. */
  team: boolean;
  onChange: (status: BitwardenSecretsStatus) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<string>(BITWARDEN_SERVERS[0]);
  const [ownServer, setOwnServer] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setAccessToken(""); setOpen(false); };
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<BitwardenSecretsStatus>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try { await onChange(await work()); if (kind === "connect") close(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.vault.bitwardenSecrets.error")); }
    finally { setBusy(null); }
  };
  const serverUrl = server === SELF_HOSTED ? ownServer.trim() : server;
  const ready = Boolean(serverUrl && accessToken.trim());
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void run("connect", () => connectBitwardenSecrets({ serverUrl, accessToken: accessToken.trim() }));
  };
  const line = status.connected
    ? t("settings.vault.bitwardenSecrets.connected", { server: status.server ?? "Bitwarden", count: String(status.items ?? 0) })
    : t("settings.vault.bitwardenSecrets.line");
  return (
    <section className="flex flex-col gap-2 px-4 py-3" aria-label={t("settings.vault.bitwardenSecrets.title")} data-bitwarden-secrets>
      <div className="flex items-center gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] leading-5 text-ink">{t("settings.vault.bitwardenSecrets.title")}</span>
          <span className="text-[13px] leading-[18px] text-ink-secondary" data-bitwarden-secrets-line>{line}</span>
        </div>
        {status.connected ? <>
          <button type="button" className="settings-quiet cursor-pointer" disabled={disabled || busy !== null} onClick={() => void run("refresh", refreshBitwardenSecrets)}>{t("settings.logins.onePassword.refresh")}</button>
          <button type="button" className="ui-button" disabled={disabled || busy !== null} aria-label={t("settings.vault.bitwardenSecrets.disconnect")}
            onClick={() => void run("disconnect", disconnectBitwardenSecrets)}>{t("settings.logins.onePassword.disconnect")}</button>
        </> : <button type="button" className="ui-button" disabled={disabled} onClick={() => setOpen(true)}>{t("settings.vault.bitwardenSecrets.connect")}</button>}
      </div>
      {team && <p className="text-[12px] leading-4 text-ink-tertiary" data-bitwarden-secrets-team>{t("settings.vault.bitwardenSecrets.team")}</p>}
      {status.connected && status.error && <p role="alert" className="text-[12px] leading-4 text-danger">{status.error}</p>}
      {error && !open && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      {open && !status.connected && (
        <SettingsDialog title={t("settings.vault.bitwardenSecrets.connect")} onClose={close}
          footer={<>
            <button type="button" className="ui-button" onClick={close}>{t("common.cancel")}</button>
            <button type="submit" form="bitwarden-secrets-connect" className="ui-button ui-button-primary gap-1.5" disabled={disabled || busy !== null || !ready}>
              {busy === "connect" && <Loader2 size={13} className="animate-spin" />}{t("settings.vault.bitwardenSecrets.connect")}
            </button>
          </>}>
          <form id="bitwarden-secrets-connect" className="flex flex-col gap-3" onSubmit={connect}>
            <p className="text-[13px] leading-[18px] text-ink-secondary" data-bitwarden-secrets-guide>{t("settings.vault.bitwardenSecrets.guide")}</p>
            <SettingsField label={t("settings.vault.bitwarden.server")}>
              <Select name="bitwardenSecretsServer" value={server} onChange={(event) => setServer(event.target.value)} disabled={busy !== null}>
                <option value={BITWARDEN_SERVERS[0]}>bitwarden.com</option>
                <option value={BITWARDEN_SERVERS[1]}>bitwarden.eu</option>
                <option value={SELF_HOSTED}>{t("settings.vault.bitwarden.selfHosted")}</option>
              </Select>
            </SettingsField>
            {server === SELF_HOSTED && (
              <SettingsField label={t("settings.vault.bitwarden.address")}>
                <input name="bitwardenSecretsServerUrl" type="url" autoComplete="off" spellCheck={false} placeholder="https://vault.example.com" maxLength={2048}
                  value={ownServer} onChange={(event) => setOwnServer(event.target.value)} disabled={busy !== null} className={SETTINGS_INPUT} />
              </SettingsField>
            )}
            <SettingsField label={t("settings.vault.bitwardenSecrets.token")} hint={t("settings.vault.bitwardenSecrets.note")}>
              <input name="bitwardenSecretsToken" type="password" autoComplete="off" spellCheck={false} maxLength={1024} value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)} disabled={busy !== null} className={SETTINGS_INPUT} />
            </SettingsField>
            {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
          </form>
        </SettingsDialog>
      )}
    </section>
  );
}
