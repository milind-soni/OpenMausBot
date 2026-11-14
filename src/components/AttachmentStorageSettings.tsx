import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { SettingRow } from "./SettingsPrimitives";

interface Usage { usedBytes: number; maxBytes: number }
interface Cleared extends Usage { removed: number; freedBytes: number; failed: number }

/** Whole MB, or KB below one MB so a small store or a small clear never reads as "0 MB". */
const size = (bytes: number) => bytes === 0 || bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.ceil(bytes / 1024)} KB`;

/** Settings → General: how full the attachments store is, and a clear for when it is. Absent where the server has none
 * (a Team Cloud, or a session that is not the owner's). */
export function AttachmentStorageSettings() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    api("/api/attachment-storage").then((body) => { if (live) setUsage(body as Usage); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!usage) return null;

  const clear = async () => {
    setClearing(true);
    setResult(null);
    try {
      const body = await api("/api/attachment-storage", { method: "POST" }) as Cleared;
      setUsage(body);
      const cleared = t("settings.attachments.cleared", { count: body.removed, freed: size(body.freedBytes) });
      setResult(body.failed > 0
        ? { kind: "error", message: `${cleared} ${t("settings.attachments.failed", { count: body.failed })}` }
        : { kind: "success", message: cleared });
    } catch (error) {
      setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.attachments.title")}
      subtitle={<>
        <span data-attachments-used className="block">{t("settings.attachments.used", { used: size(usage.usedBytes), max: size(usage.maxBytes) })}</span>
        {confirming && <span className="block">{t("settings.attachments.confirmText")}</span>}
      </>}
      message={result && <p role={result.kind === "error" ? "alert" : "status"} className={cn(result.kind === "error" ? "text-danger" : "text-success")}>
        {result.message}
      </p>}
    >
      <div className="flex flex-wrap gap-2">
        {confirming ? <>
          <button type="button" onClick={() => setConfirming(false)} disabled={clearing} className="ui-button">{t("settings.attachments.cancel")}</button>
          <button type="button" onClick={() => void clear()} disabled={clearing} className="ui-button !bg-danger !text-danger-ink">
            {clearing ? t("settings.attachments.clearing") : t("settings.attachments.confirm")}
          </button>
        </> : <button type="button" title={t("settings.attachments.help")} onClick={() => { setResult(null); setConfirming(true); }} className="ui-button">{t("settings.attachments.clear")}</button>}
      </div>
    </SettingRow>
  );
}
