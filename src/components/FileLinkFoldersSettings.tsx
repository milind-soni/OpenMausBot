import { use, useState } from "react";
import { Trash2 } from "lucide-react";

import { t } from "@/lib/i18n";
import { REVEALABLE_PATH } from "@/lib/reveal-host-path";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, StoreContext, type ConfigStatus } from "@/state/store";
import { sameFields, useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { SETTINGS_INLINE_INPUT, SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

function parentFolderPath(filePath: string): string {
  const clean = filePath.replace(/[\\/]+$/, "");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (slash < 0) return "";
  if (slash === 0) return "/";
  const parent = clean.slice(0, slash);
  return /^[a-z]:$/i.test(parent) ? `${parent}\\` : parent;
}

/** Inline owner action beside an out-of-workspace path on self-hosted remote clients. */
export function AllowFileLinkFolderButton({ filePath }: { filePath: string }) {
  const store = use(StoreContext);
  const isOwner = useOwnerOrAdmin();
  const [allowing, setAllowing] = useState(false);
  const [allowedNow, setAllowedNow] = useState(false);
  const [problem, setProblem] = useState("");
  const folder = store && isOwner === true && !store.state.config?.cloudHome && REVEALABLE_PATH.test(filePath)
    ? parentFolderPath(filePath)
    : "";
  const existingRoots = store?.state.config?.fileLinks?.extraRoots ?? [];
  const canAllow = Boolean(store && folder && !existingRoots.includes(folder));
  if (!canAllow && !allowedNow && !problem) return null;

  const allowFolder = async () => {
    if (!store || !folder || allowing) return;
    setAllowing(true);
    setProblem("");
    try {
      const next = existingRoots.includes(folder) ? existingRoots : [...existingRoots, folder];
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ fileLinks: { extraRoots: next } }) });
      store.dispatch({ type: "configStatus", config });
      setAllowedNow(true);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : t("settings.fileLinks.error"));
    } finally {
      setAllowing(false);
    }
  };

  return (
    <>
      {canAllow && !allowedNow && (
        <button type="button" disabled={allowing} onClick={() => void allowFolder()} className="text-accent underline decoration-accent/40 hover:decoration-accent">
          {t("attach.allowFolder", { folder })}
        </button>
      )}
      {allowedNow && <span role="status" className="text-success">{t("attach.folderAllowed")}</span>}
      {problem && <span role="alert" className="text-danger">{problem}</span>}
    </>
  );
}

/** Self-hosted owner setting for extra read-only host folders bots can link in chat messages. */
export function FileLinkFoldersSettings() {
  const state = useStoreSelector((s) => ({ config: s.config }), sameFields),
    dispatch = useStoreDispatch();
  const extraRoots = state.config?.fileLinks?.extraRoots ?? [];
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (state.config?.cloudHome) return null;

  const saveRoots = async (next: string[], clearDraft = false) => {
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ fileLinks: { extraRoots: next } }),
      });
      dispatch({ type: "configStatus", config });
      if (clearDraft) setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.fileLinks.error"));
    } finally {
      setSaving(false);
    }
  };

  const addFolder = () => {
    const folder = draft.trim();
    if (!folder) return;
    if (extraRoots.includes(folder)) {
      setDraft("");
      return;
    }
    void saveRoots([...extraRoots, folder], true);
  };

  return (
    <SettingsGroup label={t("settings.fileLinks.title")} block="file-links">
      <SettingsRows>
        <SettingRow
          title={t("settings.fileLinks.foldersLabel")}
          subtitle={t("settings.fileLinks.help")}
          message={error && <p role="alert" className="text-danger">{error}</p>}
        >
          <form
            className="flex w-full max-w-sm items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addFolder();
            }}
          >
            <input
              type="text"
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("settings.fileLinks.placeholder")}
              aria-label={t("settings.fileLinks.foldersLabel")}
              className={SETTINGS_INLINE_INPUT}
            />
            <button type="submit" disabled={saving || !draft.trim()} className="ui-button shrink-0">
              {t("settings.fileLinks.add")}
            </button>
          </form>
        </SettingRow>
        {extraRoots.map((root) => (
          <div key={root} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px] text-ink">
            <code className="min-w-0 flex-1 truncate">{root}</code>
            <button
              type="button"
              disabled={saving}
              aria-label={t("settings.fileLinks.removeAria", { folder: root })}
              onClick={() => void saveRoots(extraRoots.filter((entry) => entry !== root))}
              className="ui-icon-button shrink-0 text-ink-secondary hover:text-danger"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </SettingsRows>
    </SettingsGroup>
  );
}
