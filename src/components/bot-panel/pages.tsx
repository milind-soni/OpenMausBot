import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FolderOpen, Plus, Server, Users } from "lucide-react";

import { appSwitchPatch } from "@/lib/bot-app-access";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { useFeature } from "@/lib/use-feature";
import { t } from "@/lib/i18n";
import { mcpServersForBot, mcpServersOfBot, mcpSwitch, useMcpServers } from "@/lib/mcp-servers";
import { fetchMemoryOverview, markMemoryReviewed, MEMORY_INDEX, saveMemoryDoc, saveThreadNotes, type LendingReview } from "@/lib/memory";
import { openExternalLink } from "@/lib/app-links";
import type { Routine } from "@/lib/routines";
import type { SkillImportSummary } from "../../../shared/skill-import";
import { shortPath } from "@/lib/short-path";
import { skillImportLines } from "@/lib/skill-import";
import { ApiError, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { connectAppFromBot } from "../AppGrantPrompt";
import { ServiceIcon } from "../ServiceIcon";
import { RoutineEditor } from "../RoutinesPage";
import { useWorkingFolder } from "../bot-settings/AccessSection";
import { useBotEditor } from "../bot-settings/BotEditorContext";
import { OrgSkillsCard } from "../bot-settings/OrgSkillsCard";
import { SavedWorkflowsCard } from "../skill-burger/SavedWorkflowsCard";
import { isBurgerSource } from "../../../shared/skill-burger/saved";
import { canUseOnAllBots, onAllBots, SkillReviewDialog, skillSwitchOn, useManagedSkills, type ManagedSkill } from "../bot-settings/SkillsSection";
import { useBotApps, type BotApp } from "../bot-settings/useBotApps";
import { useChoosesVisibility, VisibilitySection } from "../bot-settings/VisibilitySection";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { RoutineList } from "../routines/RoutineList";
import { BrowserLogins } from "./browser-logins";
import { useOpenComputer, WherePage } from "./ComputerTab";
import { SettingsPage } from "./SettingsPage";
import { MemoryText } from "./MemoryText";
import { LendingReviewNotice } from "../bot-settings/MemorySection";
import { useTeamMemoryEntries } from "../conversation-share/conversation-share";
import type { SimplePageId } from "./page-registry";
import { BotSwitch, buttonCls, Card, ItemRow, LinkRow, NoteRow, RadioRow, RowIcon, rowCls, RowText, SwitchRow, TextRow, TrashButton } from "./rows";
import { useMemoryDoc } from "./use-memory-doc";
import { sameFields, useStoreDispatch, useStoreSelector } from "@/state/store-select";

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
  const dispatch = useStoreDispatch();
  const apps = useBotApps(bot);
  const { servers: allServers, error: mcpError } = useMcpServers();
  const { patch, canUseConnectedApps } = derived;
  const servers = allServers ? mcpServersOfBot(allServers, bot.id) : [];
  const mounted = new Set(mcpServersForBot(servers, bot.mcpServers, bot.id).map((server) => server.name));

  const toggle = (app: BotApp) => {
    const next = appSwitchPatch(bot, apps.connectedSlugs, app.slug, app.scope === null);
    if (Object.keys(next).length > 0) patch(next);
  };
  const toggleServer = (name: string) => {
    if (bot.busy || mcpError) return;
    patch({ mcpServers: mcpSwitch(servers, bot.mcpServers, name) });
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
      {(servers.length > 0 || mcpError) && (
        <Card label={t("connectors.tab.mcp")}>
          {mcpError && <NoteRow>{t("botAccess.mcpRefreshError")}</NoteRow>}
          {servers.map((server) => (
            <div key={server.name} data-simple-mcp={server.name} className={rowCls}>
              <RowIcon icon={Server} />
              <RowText
                title={<span className="block truncate">{server.name}</span>}
                hint={!server.enabled ? t("botAccess.mcpDisabled") : server.offFor?.includes(bot.id) ? t("mcp.offFor", { bots: bot.name }) : undefined}
              />
              <BotSwitch
                color={bot.color}
                checked={mounted.has(server.name)}
                aria-label={t("botSettings.simple.appToggle", { name: bot.name, app: server.name })}
                disabled={!server.enabled || Boolean(bot.busy) || mcpError}
                onClick={() => toggleServer(server.name)}
                className="disabled:cursor-not-allowed"
              />
            </div>
          ))}
        </Card>
      )}
      <Card>
        <LinkRow
          data-panel-link="add-app"
          icon={Plus}
          onClick={() => connectAppFromBot(dispatch, bot.id)}
        >
          {t("botPanel.apps.connectAnother")}
        </LinkRow>
      </Card>
    </>
  );
}

export function RoutinesPage({ bot, derived }: PageContext) {
  const state = useStoreSelector((s) => ({ config: s.config, routineRuns: s.routineRuns, routinesLoadState: s.routinesLoadState }), sameFields), dispatch = useStoreDispatch();
  // Arriving with no routines means the person asked to add one, so the editor opens straight away.
  const [editing, setEditing] = useState<Routine | "new" | null>(() => derived.botRoutines.length === 0 ? "new" : null);
  return (
    <>
      <RoutineList
        routines={derived.botRoutines}
        runs={state.routineRuns}
        pausedBots={state.config?.pausedBots}
        heldBots={state.config?.heldBots}
        loading={state.routinesLoadState === "loading" && derived.botRoutines.length === 0}
        error={state.routinesLoadState === "error"}
        unreadable={state.config?.routinesUnreadable}
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

/** The bot's memory as plain text, saved as the person types: this conversation's own notes when it keeps them, and
 * MEMORY.md, which loads in every conversation. On a Team Cloud the notes are the person's own layer of the bot's
 * memory, its topic files included, with the lines they saved to the team's memory. */
export function MemoryPage({ bot }: PageContext) {
  const memory = useMemoryDoc(bot);
  const memoryOn = bot.memoryEnabled !== false;
  const teamSaved = useTeamMemoryEntries(bot.id, memory.mine && memoryOn && !bot.defaultBot?.person, memory.docs);
  if (!memoryOn) return <Card><NoteRow>{t("botPanel.library.memoryOff", { name: bot.name })}</NoteRow></Card>;
  if (memory.error) return <Card><NoteRow tone="warn">{t("botPanel.library.memoryError")}</NoteRow></Card>;
  const index = memory.docs?.find((doc) => doc.path === MEMORY_INDEX);
  if (!index) return <Card><NoteRow>{t("common.checking")}</NoteRow></Card>;
  const thread = memory.thread;
  const topics = memory.mine ? memory.docs!.filter((doc) => doc.path !== MEMORY_INDEX) : [];
  return (
    <div key={`${bot.id}:${bot.threadId}`} data-panel-memory="" className="flex flex-col gap-4 px-1 pt-2">
      {!memory.mine && <MemoryReviewNotice bot={bot} />}
      {thread && (thread.scoped || thread.text.trim()) && (
        <MemoryText attr="thread" label={t("memoryPage.thisThread")} doc={thread} placeholder={t("memoryPage.empty")}
          save={(text, hash) => saveThreadNotes(bot.id, bot.threadId, text, hash)} />
      )}
      <MemoryText attr="everywhere" label={t("memoryPage.everywhere")} doc={index} placeholder={t("memoryPage.empty")}
        save={(text, hash) => saveMemoryDoc(bot.id, MEMORY_INDEX, text, hash, memory.mine)} />
      {topics.map((doc) => (
        <MemoryText key={doc.path} attr={doc.path} label={doc.path.replace(/^memory\//, "").replace(/\.md$/, "")} doc={doc} placeholder={t("memoryPage.empty")}
          save={(text, hash) => saveMemoryDoc(bot.id, doc.path, text, hash, true)} />
      ))}
      {teamSaved.entries.length > 0 && (
        <Card>
          {teamSaved.entries.map((entry) => (
            <div key={entry.id} data-team-memory-entry={entry.id} className={rowCls}>
              <div className="min-w-0 flex-1 text-[13px] leading-[1.45] text-ink">
                {entry.text}
                {entry.yours && <span className="block text-[12px] text-ink-secondary">{t("teamMemorySave.yours")}</span>}
              </div>
              <TrashButton label={t("botPanel.memory.forget")} onClick={() => void teamSaved.remove(entry.id)} />
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

/** On a Cloud lending this computer, a change someone else made to the bot's memory holds lent turns until the owner
 * has looked: the one review this page keeps. */
function MemoryReviewNotice({ bot }: { bot: Pick<Bot, "id" | "busy"> }) {
  const [review, setReview] = useState<{ value: LendingReview; stale: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => fetchMemoryOverview(bot.id).then((overview) => {
    setReview((current) => (overview.lendingReview ? { value: overview.lendingReview, stale: current?.stale ?? false } : null));
  }, () => {}), [bot.id]);
  useEffect(() => { void load(); }, [load, bot.busy]);
  if (!review) return null;
  const reviewed = async () => {
    setBusy(true);
    try {
      await markMemoryReviewed(bot.id, review.value.token);
      setReview(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setReview({ ...review, stale: true });
        await load();
      }
    } finally {
      setBusy(false);
    }
  };
  return <LendingReviewNotice changed={review.value.changed} stale={review.stale} busy={busy} onReviewed={() => void reviewed()} />;
}

export function SkillsPage({ bot }: PageContext) {
  const { request: api } = useBotEditor();
  const state = useStoreSelector((s) => ({ config: s.config }), sameFields), dispatch = useStoreDispatch();
  const skills = useManagedSkills(bot);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string[]>([]);
  const libraryOn = skillsLibraryEnabled(state.config), skillBurger = useFeature("skillBurger");
  const own = skills.skills.filter((skill) => skill.origin !== "project" && !isBurgerSource(skill.source));
  const project = skills.skills.filter((skill) => skill.origin === "project");

  const remove = async (skill: ManagedSkill) => {
    if (skills.working) return;
    if (!window.confirm(t(skill.origin === "library" ? "skills.unassignConfirm" : skill.allBots ? "skills.allBots.removeConfirm" : "botPanel.skills.removeConfirm", { name: skill.name }))) return;
    skills.setWorking(skill.name);
    skills.setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}${skill.allBots ? "/all-bots" : ""}`, { method: "DELETE" });
      await skills.refresh();
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
    setImported([]);
    try {
      const result = await api<{ imported?: SkillImportSummary[] }>(`/api/bots/${bot.id}/skills`, { method: "POST", body: JSON.stringify({ source: trimmed }) });
      setImported(skillImportLines(result.imported ?? []));
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
      {skillBurger && <SavedWorkflowsCard botId={bot.id} threadId={bot.threadId} />}
      <Card>
        {skills.loading ? (
          <NoteRow>{t("skills.loading")}</NoteRow>
        ) : own.length === 0 ? (
          <NoteRow>{t("botSettings.simple.noSkills")}</NoteRow>
        ) : own.map((skill) => (
          <SwitchRow
            key={skill.name}
            data-panel-row={`skill:${skill.name}`}
            title={onAllBots(skill) ? <>{skill.name}<span data-panel-tag="all-bots" title={t("skills.allBots.tagHint")} className="ml-1.5 rounded bg-ink/[0.06] px-1.5 py-px align-[1px] text-[11px] font-normal text-ink-secondary">{t("skills.allBots.tag")}</span></> : skill.name}
            hint={skill.description || skill.source}
            label={t("botSettings.simple.skillToggle", { name: skill.name })}
            color={bot.color}
            checked={skillSwitchOn(skill)}
            disabled={Boolean(skills.working)}
            onChange={() => void skills.toggle(skill)}
            extra={skill.origin === "imported" || skill.origin === "native" ? undefined : <>
              {canUseOnAllBots(skill) && (
                <button type="button" data-panel-action={`all-bots-skill:${skill.name}`} aria-label={t("skills.allBots.useName", { name: skill.name })} title={t("skills.allBots.use")}
                  disabled={Boolean(skills.working)} onClick={() => void skills.putOnAllBots(skill)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary hover:bg-ink/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50">
                  <Users size={15} />
                </button>
              )}
              <TrashButton data-panel-action={`remove-skill:${skill.name}`} label={t("botPanel.skills.remove", { name: skill.name })} disabled={Boolean(skills.working)} onClick={() => void remove(skill)} />
            </>}
          />
        ))}
        {skills.note && <NoteRow>{skills.note}</NoteRow>}
        {skills.error && !skills.reviewing && <NoteRow tone="warn">{skills.error}</NoteRow>}
      </Card>
      {project.length > 0 && (
        <Card label={t("botPanel.skills.project")} anchor="project-skills">
          {project.map((skill) => (
            <ItemRow key={skill.name} data-panel-row={`project-skill:${skill.name}`} title={skill.name} hint={skill.description || skill.source} />
          ))}
        </Card>
      )}
      <OrgSkillsCard bot={bot} onAdded={() => void skills.refresh()} />
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
        {imported.map((line) => <NoteRow key={line}>{line}</NoteRow>)}
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

function VisibilityPage({ bot }: PageContext) {
  return useChoosesVisibility() ? <VisibilitySection bot={bot} /> : null;
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
    case "visibility":
      return <VisibilityPage {...context} />;
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
