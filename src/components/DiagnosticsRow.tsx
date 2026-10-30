import { useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";

/**
 * Where this app's logs are, and the recent part of them to share with support. Security: the report never holds
 * credential values (electron/diagnostics.mjs redacts every line); opening the folder only shows main's own logs folder.
 */
export function DiagnosticsRow({ simple = false }: { simple?: boolean }) {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [folder, setFolder] = useState<string | null>(null);

  const exportDiagnostics = async () => {
    if (!window.ogb?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.ogb.exportDiagnostics();
      if (path) setResult({ kind: "success", message: t("settings.diagnostics.saved", { path }) });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  const openLogs = async () => {
    if (!window.ogb?.openLogsFolder) return;
    setResult(null);
    try {
      const opened = await window.ogb.openLogsFolder();
      setFolder(opened.folder);
      if (!opened.opened) setResult({ kind: "error", message: t("settings.diagnostics.openFailed", { folder: opened.folder }) });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  // My Cloud's page in the app, or a browser: this computer's logs are not reachable from here.
  const here = Boolean(window.ogb?.exportDiagnostics);
  return (
    <SettingRow
      title={t("settings.diagnostics.title")}
      subtitle={t(simple ? "settings.simple.diagnostics" : "settings.diagnostics.subtitle")}
      message={<>
        {folder && result?.kind !== "error" && <p role="status" data-logs-folder className="break-all text-ink-secondary">{t("settings.diagnostics.logsAt", { folder })}</p>}
        {result && <p role={result.kind === "error" ? "alert" : "status"} className={cn("break-all", result.kind === "error" ? "text-danger" : "text-success")}>
          {result.message}
        </p>}
        <p data-logs-help className="text-ink-tertiary">{t(here ? "settings.diagnostics.logsHelp" : "settings.diagnostics.elsewhere")}</p>
      </>}
    >
      {here && <div className="flex flex-wrap gap-2">
        {window.ogb?.openLogsFolder && <button type="button" onClick={() => void openLogs()} className="ui-button">{t("settings.diagnostics.openLogs")}</button>}
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label={t("settings.diagnostics.aria")}
          className="ui-button"
        >
          {exporting ? t("settings.diagnostics.exporting") : t("settings.diagnostics.export")}
        </button>
      </div>}
    </SettingRow>
  );
}
