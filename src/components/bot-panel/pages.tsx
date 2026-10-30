import { useState, type ReactNode } from "react";
import { FolderOpen, Plus } from "lucide-react";

import { appSwitchPatch } from "@/lib/bot-app-access";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { deleteMemoryDoc, MEMORY_INDEX, saveMemoryDoc, type MemoryDoc } from "@/lib/memory";
import { openExternalLink } from "@/lib/app-links";
import type { Routine } from "@/lib/routines";
import { shortPath } from "@/lib/short-path";
import { useStore, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { ServiceIcon } from "../PluginsPanel";
import { RoutineEditor } from "../RoutinesPage";
import { useWorkingFolder } from "../bot-settings/AccessSection";
import { useBotEditor } from "../bot-settings/BotEditorContext";
import { SkillReviewDialog, useManagedSkills, type ManagedSkill } from "../bot-settings/SkillsSection";
import { useBotApps, type BotApp } from "../bot-settings/useBotApps";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { RoutineList } from "../routines/RoutineList";
import { BrowserLogins } from "./browser-logins";
import { useOpenComputer, WherePage } from "./ComputerTab";
import { SettingsPage } from "./SettingsPage";
import { panelMemoryNotes, withMemoryNote, withoutMemoryNote, type PanelMemoryNote } from "./memory-notes";
import type { SimplePageId } from "./page-registry";
import { BotSwitch, buttonCls, Card, LinkRow, NoteRow, RadioRow, rowCls, SwitchRow, TextRow, TrashButton } from "./rows";
import { useMemoryDoc } from "./use-memory-doc";

type Derived = ReturnType<typeof useBotSettingsDerived>;

export interface PageContext {
  bot: Bot;
  derived: Derived;
}

export const pageSurfaceCls = "flex flex-col gap-3";

const SKILLS_SITE = "https://skills.sh";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function AppsPage({ bot, derived }: PageContext) {
  const { dispatch } = useStore();
  const apps = useBotApps(bot);
  const { patch, canUseConnectedApps } = derived;

  const toggle = (app: BotApp) => {
    const next = appSwitchPatch(bot, apps.connectedSlugs, app.slug, app.scope === null);
    if (Object.keys(next).length > 0) patch(next);
  };
  const note = !canUseConnectedApps
    ? t("botSettings.simple.appsCannot", { name: bot.name })
    : apps.phase === "loading"
      ? t("common.checking")
      : apps.phase === "unknown"
        ? t("botSettings.simple.appsUnknown")
        : apps.apps.length === 0
          ? t("botSettings.simple.appsNone")
          : null;

  return (
    <>
      <Card>
        {note && <NoteRow>{note}</NoteRow>}
        {canUseConnectedApps && apps.apps.map((app) => (
          <div key={app.slug} data-simple-app={app.slug} className={rowCls}>
            <ServiceIcon key={`${app.card.logo}:${app.card.domain}`} card={app.card} className="size-7 shrink-0" />
            <div className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{app.label}</div>
            <BotSwitch
              color={bot.color}
              checked={app.scope !== null}
              aria-label={t("botSettings.simple.appToggle", { name: bot.name, app: app.label })}
              disabled={Boolean(bot.busy)}
              onClick={() => toggle(app)}
              className="disabled:cursor-not-allowed"
            />
          </div>
        ))}
      </Card>
      <Card>
        <LinkRow
          data-panel-link="add-app"
          icon={Plus}
          onClick={() => {
            dispatch({ type: "toggleSettings", open: false });
            dispatch({ type: "togglePlugins", open: true, surface: "apps" });
          }}
        >
          {t("botPanel.apps.connectAnother")}
        </LinkRow>
      </Card>
    </>
  );
}

export function RoutinesPage({ bot, derived }: PageContext) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  return (
    <>
      <RoutineList
        routines={derived.botRoutines}
        runs={state.routineRuns}
        loading={state.routinesLoadState === "loading" && derived.botRoutines.length === 0}
        error={state.routinesLoadState === "error"}
        onOpen={setEditing}
        onLogs={(routine) => dispatch({ type: "showRoutines", section: "logs", botId: bot.id, routineId: routine.id })}
        onToggle={(routine) => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: !routine.enabled } })}
      />
      <Card>
        <LinkRow data-panel-action="new-routine" icon={Plus} onClick={() => setEditing("new")}>{t("botPanel.routines.add")}</LinkRow>
      </Card>
      <p className="mx-1 text-[13px] leading-normal text-ink-secondary">{t("botPanel.routines.ask", { name: bot.name })}</p>
      {editing && (
        <RoutineEditor
          key={bot.id}
          routine={editing === "new" ? undefined : editing}
          bots={[bot]}
          lockedBotId={bot.id}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** MEMORY.md's bullets, and on a Team Cloud the person's own notes. Every write goes through the memory file route with
 * the hash it was read at, so a note the bot added meanwhile is never lost: a conflict re-reads and asks again. */
export function MemoryPage({ bot }: PageContext) {
  const memory = useMemoryDoc(bot);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memoryOn = bot.memoryEnabled !== false;
  const notes = memory.docs ? panelMemoryNotes(memory.docs) : null;
  const index = memory.docs?.find((doc) => doc.path === MEMORY_INDEX) ?? null;

  const change = async (save: () => Promise<boolean>) => {
    if (saving) return false;
    setSaving(true);
    setError(null);
    try {
      return await save();
    } catch (cause) {
      setError(errorText(cause, t("botPanel.library.memoryError")));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const write = (doc: MemoryDoc, text: string) => change(async () => {
    const result = await saveMemoryDoc(bot.id, doc.path, text, doc.exists ? doc.hash : undefined, memory.mine);
    if (result.ok) {
      memory.setDoc(result.doc);
      return true;
    }
    await memory.reload();
    setError(t("memory.conflict.title", { name: bot.name }));
    return false;
  });
  const forget = (note: PanelMemoryNote) => {
    const doc = memory.docs?.find((candidate) => candidate.path === note.path);
    if (!doc) return;
    if (note.line !== null) void write(doc, withoutMemoryNote(doc.text, note.line));
    else void change(async () => {
      await deleteMemoryDoc(bot.id, doc.path, memory.mine);
      await memory.reload();
      return true;
    });
  };
  const add = async () => {
    if (!index || !draft.trim()) return;
    if (await write(index, withMemoryNote(index.text, draft))) setDraft("");
  };

  return (
    <>
      <Card>
        {!memoryOn ? (
          <NoteRow>{t("botPanel.library.memoryOff", { name: bot.name })}</NoteRow>
        ) : memory.error ? (
          <NoteRow tone="warn">{t("botPanel.library.memoryError")}</NoteRow>
        ) : notes === null ? (
          <NoteRow>{t("common.checking")}</NoteRow>
        ) : notes.length === 0 ? (
          <NoteRow>{t("botPanel.memory.empty")}</NoteRow>
        ) : notes.map((note) => (
          <div key={`${note.path}:${note.line}:${note.text}`} data-memory-note={note.line ?? note.path} className={rowCls}>
            <div className="min-w-0 flex-1 text-[13px] leading-[1.45] text-ink">{note.text}</div>
            <TrashButton label={t("botPanel.memory.forget")} disabled={saving} onClick={() => forget(note)} />
          </div>
        ))}
        {error && <NoteRow tone="warn">{error}</NoteRow>}
      </Card>
      {memoryOn && (
        <Card>
          <TextRow
            data-panel-form="memory-add"
            value={draft}
            placeholder={t("botPanel.memory.addPlaceholder", { name: bot.name })}
            label={t("botPanel.memory.addPlaceholder", { name: bot.name })}
            action={t("common.add")}
            disabled={saving || index === null}
            onChange={setDraft}
            onSubmit={() => void add()}
          />
        </Card>
      )}
    </>
  );
}

export function SkillsPage({ bot }: PageContext) {
  const { request: api } = useBotEditor();
  const { state, dispatch } = useStore();
  const skills = useManagedSkills(bot);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const libraryOn = skillsLibraryEnabled(state.config);

  const remove = async (skill: ManagedSkill) => {
    if (skills.working) return;
    if (!window.confirm(t("botPanel.skills.removeConfirm", { name: skill.name }))) return;
    skills.setWorking(skill.name);
    skills.setError("");
    try {
      if (skill.origin === "library") await skills.putAssignments(skill.name, true);
      else {
        await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
        await skills.refresh();
      }
    } catch (cause) {
      skills.setError(errorText(cause, t("botPanel.skills.removeFailed")));
    } finally {
      skills.setWorking("");
    }
  };
  const importSkill = async () => {
    const trimmed = source.trim();
    if (!trimmed || importing) return;
    setImporting(true);
    skills.setError("");
    try {
      await api(`/api/bots/${bot.id}/skills`, { method: "POST", body: JSON.stringify({ source: trimmed }) });
      setSource("");
      await skills.refresh();
    } catch (cause) {
      skills.setError(errorText(cause, t("botPanel.skills.importFailed")));
    } finally {
      setImporting(false);
    }
  };
  const browse = () => {
    if (libraryOn) {
      dispatch({ type: "toggleSettings", open: false });
      dispatch({ type: "toggleAppSettings", open: true, section: "skills" });
      return;
    }
    void openExternalLink(SKILLS_SITE);
  };

  return (
    <>
      <Card>
        {skills.loading ? (
          <NoteRow>{t("skills.loading")}</NoteRow>
        ) : skills.skills.length === 0 ? (
          <NoteRow>{t("botSettings.simple.noSkills")}</NoteRow>
        ) : skills.skills.map((skill) => (
          <SwitchRow
            key={skill.name}
            data-panel-row={`skill:${skill.name}`}
            title={skill.name}
            hint={skill.description || skill.source}
            label={t("botSettings.simple.skillToggle", { name: skill.name })}
            color={bot.color}
            checked={skill.enabled}
            disabled={Boolean(skills.working)}
            onChange={() => void skills.toggle(skill)}
            extra={<TrashButton data-panel-action={`remove-skill:${skill.name}`} label={t("botPanel.skills.remove", { name: skill.name })} disabled={Boolean(skills.working)} onClick={() => void remove(skill)} />}
          />
        ))}
        {skills.error && !skills.reviewing && <NoteRow tone="warn">{skills.error}</NoteRow>}
      </Card>
      <Card>
        <TextRow
          data-panel-form="skill-import"
          value={source}
          placeholder={t("botPanel.skills.importPlaceholder")}
          label={t("skills.import.label")}
          action={importing ? t("skills.import.importing") : t("common.add")}
          disabled={importing}
          onChange={setSource}
          onSubmit={() => void importSkill()}
        />
        <LinkRow data-panel-link="browse-skills" onClick={browse}>{t("botPanel.skills.browse")}</LinkRow>
      </Card>
      {skills.reviewing && (
        <SkillReviewDialog
          skill={skills.reviewing.skill}
          text={skills.reviewing.text}
          error={skills.error}
          working={skills.working === skills.reviewing.skill.name}
          onCancel={() => skills.setReviewing(null)}
          onEnable={() => void skills.enableReviewed()}
        />
      )}
    </>
  );
}

export function FolderPage({ bot }: PageContext) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host?.homeDir;
  const { draft, setDraft, error, saving, canPick, save, pick } = useWorkingFolder(bot);
  const [choosing, setChoosing] = useState(false);
  const chosen = Boolean(bot.cwd) || choosing;

  const choose = () => {
    if (canPick) {
      void pick();
      return;
    }
    setChoosing(true);
  };

  return (
    <>
      <Card>
        <RadioRow
          data-panel-choice="private"
          title={t("botPanel.folder.own")}
          hint={t("botPanel.folder.ownHint")}
          checked={!chosen}
          disabled={saving}
          onClick={() => {
            setChoosing(false);
            if (bot.cwd) void save(null);
          }}
        />
        <RadioRow
          data-panel-choice="pick"
          title={t("botPanel.folder.pick")}
          hint={t("botPanel.folder.pickHint")}
          checked={chosen}
          disabled={saving}
          onClick={() => { if (!bot.cwd) choose(); }}
        />
      </Card>
      {chosen && (
        <Card>
          {canPick ? (
            <div className={rowCls}>
              <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[13px] text-ink" title={bot.cwd}>
                {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">{t("botAccess.folder.private")}</span>}
              </div>
              <button type="button" data-panel-action="pick-folder" disabled={saving} onClick={() => void pick()} className={buttonCls}>
                <FolderOpen size={14} aria-hidden="true" />
                {t("botAccess.folder.choose")}
              </button>
            </div>
          ) : (
            <form
              data-panel-form="folder-path"
              className={rowCls}
              onSubmit={(event) => {
                event.preventDefault();
                const path = (draft ?? bot.cwd ?? "").trim();
                if (path) void save(path);
              }}
            >
              <input
                value={draft ?? bot.cwd ?? ""}
                placeholder={t("botAccess.folder.placeholder")}
                aria-label={t("botAccess.folder.title")}
                onChange={(event) => setDraft(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-2.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border"
              />
              <button type="submit" disabled={saving || draft === null} className={buttonCls}>{t("botAccess.folder.save")}</button>
            </form>
          )}
          {error && <NoteRow tone="warn">{error}</NoteRow>}
        </Card>
      )}
    </>
  );
}

export function BrowserPage({ bot, derived }: PageContext) {
  const openComputer = useOpenComputer(bot);
  return <BrowserLogins bot={bot} browserEnabled={derived.browserEnabled} onOpenBrowser={() => openComputer("browser")} />;
}

export function PageBody({ page, onOpen, editingInstructions, onEditInstructions, ...context }: PageContext & {
  page: SimplePageId;
  onOpen?: (page: SimplePageId) => void;
  editingInstructions?: boolean;
  onEditInstructions?: (open: boolean) => void;
}): ReactNode {
  switch (page) {
    case "settings":
      return <SettingsPage {...context} onOpen={onOpen} editingInstructions={editingInstructions} onEditInstructions={onEditInstructions} />;
    case "where":
      return <WherePage {...context} />;
    case "apps":
      return <AppsPage {...context} />;
    case "routines":
      return <RoutinesPage {...context} />;
    case "memory":
      return <MemoryPage {...context} />;
    case "skills":
      return <SkillsPage {...context} />;
    case "folder":
      return <FolderPage {...context} />;
    case "browser":
      return <BrowserPage {...context} />;
  }
}
