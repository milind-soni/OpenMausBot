import { useState } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { Switch } from "./SettingsPrimitives";

export function McpAppsSwitch<T>({ server, disabled, onSaved }: {
  server: { name: string; apps?: boolean; hasApps?: boolean };
  disabled: boolean;
  onSaved(servers: T[]): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (typeof server.apps !== "boolean") return null;
  if (server.apps && server.hasApps !== true) return null;
  const on = server.apps;
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ servers?: T[] }>(`/api/mcp/servers/${encodeURIComponent(server.name)}`, { method: "PATCH", body: JSON.stringify({ apps: !on }) });
      onSaved(result.servers ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-mcp-apps={server.name} className="mt-3 flex items-center gap-3 border-t border-hairline/40 pt-3">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-ink">{t("mcp.apps.title")}</div>
        <div role={error ? "alert" : undefined} className={error ? "mt-0.5 text-[11.5px] text-danger" : "mt-0.5 text-[11.5px] text-ink-secondary"}>{error ?? t("mcp.apps.desc")}</div>
      </div>
      {busy && <Loader2 aria-hidden="true" size={13} className="animate-spin text-ink-secondary" />}
      <Switch checked={on} disabled={disabled || busy} onClick={() => void toggle()} aria-label={t("mcp.apps.toggleAria", { name: server.name })} className="disabled:opacity-40" />
    </div>
  );
}
