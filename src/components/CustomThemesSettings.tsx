import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { themeCssProblem, THEME_LIMITS, type ThemeExport, type ThemeFile, type ThemeList } from "../../shared/theme";
import { t } from "@/lib/i18n";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { chooseTheme, loadTheme, resetLook, safeLook, subscribeTheme, wornTheme } from "@/lib/theme/runtime";
import { api } from "@/state/api";
import { SETTINGS_INPUT, SettingRow, SettingsEmptyRow, SettingsField, SettingsFormFoot, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useWornId(): string | null {
  return useSyncExternalStore(subscribeTheme, () => wornTheme()?.id ?? null, () => null);
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

type Act = (work: () => Promise<unknown>) => Promise<void>;

/** One theme opened: its name, two colours and its CSS, with what is done less often beside Save. */
function ThemeEditor({ id, act, onClose, onDelete }: { id: string; act: Act; onClose: () => void; onDelete: () => void }) {
  const [file, setFile] = useState<ThemeFile | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api<{ theme: ThemeFile }>(`/api/themes/${id}`).then((answer) => setFile(answer.theme), (error: unknown) => setStatus(errorText(error)));
  }, [id]);
  if (!file) return <SettingsEmptyRow>{status ?? t("settings.customThemes.loading")}</SettingsEmptyRow>;
  const problem = file.css ? themeCssProblem(file.css) : null;
  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/themes/${id}`, put({ theme: { ...file, name: file.name.trim(), css: file.css || undefined } }));
      setStatus(t("settings.customThemes.saved"));
      await loadTheme();
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-settings-block="theme-editor" className="flex flex-col gap-3 px-4 py-3">
      <SettingsField label={t("settings.customThemes.name")}>
        <input className={SETTINGS_INPUT} value={file.name} maxLength={60} onChange={(event) => setFile({ ...file, name: event.target.value })} />
      </SettingsField>
      <div className="flex flex-wrap gap-4">
        {(["canvas", "accent"] as const).map((key) => (
          <label key={key} className="flex items-center gap-2 text-[13px] text-ink">
            <input type="color" className="size-7 cursor-pointer rounded-md bg-transparent" value={file[key] ?? (key === "canvas" ? "#121212" : "#1084fe")}
              onChange={(event) => setFile({ ...file, [key]: event.target.value })} />
            {t(key === "canvas" ? "settings.customThemes.canvas" : "settings.customThemes.accent")}
            {file[key] && <button type="button" className="text-[12px] text-accent-text hover:underline" onClick={() => setFile({ ...file, [key]: undefined })}>{t("settings.customThemes.clear")}</button>}
          </label>
        ))}
      </div>
      <SettingsField label={t("settings.customThemes.css")} hint={problem ?? t("settings.customThemes.cssHint")}>
        <textarea className={`${SETTINGS_INPUT} h-64 resize-y py-2 font-mono text-[12px]`} spellCheck={false} maxLength={THEME_LIMITS.cssChars}
          aria-label={t("settings.customThemes.css")} value={file.css ?? ""} onChange={(event) => setFile({ ...file, css: event.target.value })} />
      </SettingsField>
      <SettingsFormFoot status={status}>
        <div className="mr-auto flex flex-wrap gap-1.5">
          <button type="button" className="ui-button ui-button-sm"
            onClick={() => void act(() => api(`/api/themes/${id}/duplicate`, { method: "POST", body: JSON.stringify({ name: t("settings.customThemes.copyName", { name: file.name }).slice(0, 60) }) }))}>
            {t("settings.customThemes.duplicate")}
          </button>
          <button type="button" className="ui-button ui-button-sm" onClick={() => void act(async () => download(`${id}.mausbot-theme.json`, await api(`/api/themes/${id}/export`)))}>
            {t("settings.customThemes.export")}
          </button>
          <button type="button" className="ui-button ui-button-sm" data-danger="" onClick={onDelete}>{t("common.delete")}</button>
        </div>
        <button type="button" className="ui-button" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="ui-button ui-button-primary" disabled={saving || Boolean(problem) || !file.name.trim()} onClick={() => void save()}>{t("common.save")}</button>
      </SettingsFormFoot>
    </div>
  );
}

/** Settings → Appearance: the person's saved themes, made by them or by a bot. */
export function CustomThemesSettings() {
  const [list, setList] = useState<ThemeList | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<ReactNode>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const worn = useWornId();
  const refresh = useCallback(() => api<ThemeList>("/api/themes").then(setList, (error: unknown) => setStatus(errorText(error))), []);
  useEffect(() => {
    void refresh();
    return subscribeTheme(() => void refresh());
  }, [refresh]);

  const act: Act = async (work) => {
    setStatus(null);
    try {
      await work();
    } catch (error) {
      setStatus(errorText(error));
    }
    await refresh();
  };
  const create = () => act(async () => {
    const id = `theme-${Date.now().toString(36)}`;
    await api(`/api/themes/${id}`, put({ theme: { name: t("settings.customThemes.newName") } }));
    setEditing(id);
  });
  const importFile = (file: File | undefined) => file && act(async () => {
    let data: ThemeExport;
    try {
      data = JSON.parse(await file.text()) as ThemeExport;
    } catch {
      throw new Error(t("settings.customThemes.importFailed"));
    }
    await api("/api/themes/import", { method: "POST", body: JSON.stringify(data) });
  });
  /** Deleted at once; the export taken just before brings it back. */
  const remove = (id: string, name: string) => act(async () => {
    const kept = await api<ThemeExport>(`/api/themes/${id}/export`);
    await api(`/api/themes/${id}`, { method: "DELETE" });
    setEditing(null);
    await loadTheme();
    setStatus(<>{t("settings.customThemes.deleted", { name })}{" "}
      <button type="button" className="text-accent-text hover:underline" onClick={() => void act(() => api("/api/themes/import", { method: "POST", body: JSON.stringify(kept) }))}>
        {t("common.undo")}
      </button></>);
  });
  const keys = isMacPlatform() ? "⌘⌥⇧R" : "Ctrl+Alt+Shift+R";

  return (
    <SettingsGroup label={t("settings.customThemes.title")} block="custom-themes" description={t("settings.customThemes.description")}
      actions={<>
        <button type="button" className="ui-button" onClick={() => importRef.current?.click()}>{t("settings.customThemes.import")}</button>
        <button type="button" className="ui-button" onClick={() => void create()}>{t("settings.customThemes.new")}</button>
        <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
      </>}
      footnote={status}>
      <SettingsRows>
        {safeLook() && <SettingsEmptyRow>{t("settings.customThemes.safe")}</SettingsEmptyRow>}
        {list && !list.themes.length && <SettingsEmptyRow>{t("settings.customThemes.empty")}</SettingsEmptyRow>}
        {list?.themes.map((theme) => (
          editing === theme.id
            ? <ThemeEditor key={theme.id} id={theme.id} act={act} onClose={() => { setEditing(null); void refresh(); }} onDelete={() => void remove(theme.id, theme.name)} />
            : (
              <SettingRow key={theme.id} title={theme.name}
                subtitle={worn === theme.id ? t("settings.customThemes.inUse") : theme.assets.length ? t("settings.customThemes.files", { count: theme.assets.length }) : undefined}>
                <div className="flex items-center gap-1.5">
                  <button type="button" className="ui-button" onClick={() => setEditing(theme.id)}>{t("settings.customThemes.edit")}</button>
                  {worn === theme.id
                    ? <button type="button" className="ui-button" onClick={() => void act(() => chooseTheme(null))}>{t("settings.customThemes.takeOff")}</button>
                    : <button type="button" className="ui-button ui-button-primary" onClick={() => void act(() => chooseTheme(theme.id))}>{t("settings.customThemes.use")}</button>}
                </div>
              </SettingRow>
            )
        ))}
        <SettingRow title={t("settings.customThemes.reset")} subtitle={t("settings.customThemes.resetHint", { keys })}>
          <button type="button" className="ui-button" onClick={() => { resetLook(); void refresh(); }}>{t("settings.customThemes.reset")}</button>
        </SettingRow>
      </SettingsRows>
    </SettingsGroup>
  );
}
