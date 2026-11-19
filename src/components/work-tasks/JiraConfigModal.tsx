import { useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import type { RoomJiraPublicConfig } from "../../../shared/work-tasks";
import { saveRoomJiraConfig } from "./work-tasks-api";

export function JiraConfigModal({
  roomId,
  initial,
  onClose,
  onSaved,
}: {
  roomId: string;
  initial: RoomJiraPublicConfig;
  onClose: () => void;
  onSaved: (next: RoomJiraPublicConfig) => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [email, setEmail] = useState(initial.email);
  const [apiToken, setApiToken] = useState("");
  const [projectKey, setProjectKey] = useState(initial.projectKey);
  const [issueType, setIssueType] = useState(initial.issueType || "Task");
  const [assigneeCustomFieldId, setAssigneeCustomFieldId] = useState(initial.assigneeCustomFieldId ?? "");
  const [autoSync, setAutoSync] = useState(initial.autoSync);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await saveRoomJiraConfig(roomId, {
        enabled,
        baseUrl,
        email,
        projectKey,
        issueType,
        assigneeCustomFieldId: assigneeCustomFieldId || undefined,
        autoSync,
        ...(apiToken.trim() ? { apiToken: apiToken.trim() } : {}),
      });
      onSaved(res.config);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-3 rounded-2xl border border-hairline bg-panel p-5 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-ink">{t("workTasks.jira.settingsTitle")}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-secondary hover:bg-ink/[0.06]">
            <X size={16} />
          </button>
        </div>

        <p className="text-[12px] text-ink-secondary">{t("workTasks.jira.settingsHint")}</p>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}

        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t("workTasks.jira.enable")}</span>
        </label>

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">Jira Base URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-org.atlassian.net"
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-ink"
          />
        </label>

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">Atlassian Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="team@company.com"
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-ink"
          />
        </label>

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">
            API Token {initial.hasApiToken ? `(${t("workTasks.jira.tokenSaved")})` : ""}
          </span>
          <input
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder={initial.hasApiToken ? "••••••••" : "ATATT3x..."}
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-ink"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1 text-[12px]">
            <span className="font-medium text-ink-secondary">Project Key</span>
            <input
              type="text"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value.toUpperCase())}
              placeholder="PROJ"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 font-mono text-ink"
            />
          </label>
          <label className="block space-y-1 text-[12px]">
            <span className="font-medium text-ink-secondary">Default Issue Type</span>
            <input
              type="text"
              value={issueType}
              onChange={(e) => setIssueType(e.target.value)}
              placeholder="Task"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-ink"
            />
          </label>
        </div>

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">{t("workTasks.jira.customField")}</span>
          <input
            type="text"
            value={assigneeCustomFieldId}
            onChange={(e) => setAssigneeCustomFieldId(e.target.value)}
            placeholder="customfield_10042"
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 font-mono text-ink"
          />
        </label>

        <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
          <span>{t("workTasks.jira.autoSync")}</span>
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.06]"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-ink px-4 py-1.5 text-[13px] font-medium text-app hover:opacity-90 disabled:opacity-50"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

