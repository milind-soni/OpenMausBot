import { botSandboxLines } from "@/lib/bot-sandbox";
import { t } from "@/lib/i18n";
import { useStoreSelector } from "@/state/store-select";
import { SettingRow } from "./SettingsPrimitives";

/** Settings, Updates, on a self-hosted server: whether bots' commands run in the sandbox, read-only. Admins only; the
 * server sends `botSandbox` only from its published image or with OMB_BOT_BOX=required. */
export function BotSandboxRow() {
  const status = useStoreSelector((state) => state.config?.botSandbox);
  if (!status) return null;
  const lines = botSandboxLines(status, typeof window === "undefined" ? "" : window.location.hostname);
  return (
    <SettingRow
      title={t("botSandbox.title")}
      subtitle={lines.detail}
      message={lines.command ? <span className="text-ink-secondary">{t("botSandbox.fix")} <code className="select-all break-all">{lines.command}</code></span> : undefined}
    >
      <span data-bot-sandbox={status.state} className={lines.tone === "danger" ? "text-[14px] text-danger" : "text-[14px] text-ink-secondary"}>{lines.value}</span>
    </SettingRow>
  );
}
