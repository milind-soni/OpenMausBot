import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { api, BotEditorStore, useStore, type Bot } from "@/state/store";
import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "@/lib/bot-creation-draft";
import { createConfiguredBot, preparedBotTemplate } from "@/lib/create-configured-bot";
import { BOT_ROLES, roleProfilePatch } from "@/lib/bot-roles";
import { readyBot, readyBotTemplate } from "@/lib/ready-bots";
import { chosenPreset, presetDraftPatch, presetGroups, presetPictureFile, presetSummaryLines, type BotPreset } from "@/lib/bot-presets";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useAdvancedMode } from "@/lib/interface-mode";
import { announceNewBot, reportsToFor, startingTemplate, type BotDefaultsAnswer } from "@/lib/new-bot";
import { useShowThreads } from "@/lib/thread-preferences";
import { openServerMenu } from "./DesktopWorkspaceSwitcher";
import { useTeamPeople } from "@/state/team-people";
import { visibilityFromForm, type VisibilityMode } from "./bot-settings/VisibilitySection";
import type { Routine } from "@/lib/routines";
import { IdentitySection } from "./bot-settings/IdentitySection";
import { SoulSection } from "./bot-settings/SoulSection";
import { SkillsSection } from "./bot-settings/SkillsSection";
import { AccessSection } from "./bot-settings/AccessSection";
import { ModelSection } from "./bot-settings/ModelSection";
import { PermissionsSection } from "./bot-settings/PermissionsSection";
import { VoiceSection } from "./bot-settings/VoiceSection";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { BotEditorContext } from "./bot-settings/BotEditorContext";
import { inputCls } from "./bot-settings/field";
import { RoutineEditor } from "./RoutinesPage";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { SharePresetDialog } from "./SharePresetDialog";
import { SettingRow } from "./SettingsPrimitives";
import { Select } from "./Select";

const SECTIONS = ["Identity", "Soul", "Skills", "Memory", "Routines", "Access", "Model", "Permissions", "Voice & alerts"] as const;
type Section = typeof SECTIONS[number];
const SECTION_KEYS: Record<Section, LocaleKey> = {
  Identity: "botSettings.sections.identity", Soul: "botSettings.sections.soul", Skills: "botSettings.sections.skills",
  Memory: "botSettings.sections.memory", Routines: "botSettings.sections.routines", Access: "botSettings.sections.access",
  Model: "botSettings.sections.model", Permissions: "botSettings.sections.permissions", "Voice & alerts": "botSettings.sections.voice",
};

/** The bot editor over the New bot defaults: saving them (`defaultsMode`), or a ready-made bot from Templates to review
 * before it is created. */
export function NewBotDialog({ defaultsMode = false, onClose, onCreated, readyBotId }: {
  defaultsMode?: boolean; onClose: () => void; onCreated?: (bot: Bot) => void | Promise<void>;
  /** A ready-made bot from the Templates gallery, filled in over the person's New bot defaults. */
  readyBotId?: string;
}) {
  const parent = useStore();
  const [, render] = useState(0);
  const [draft, setDraft] = useState(() => new BotCreationDraft(EMPTY_BOT_DEFAULTS, () => render(value => value + 1)));
  const [active, setActive] = useState<Section>("Identity");
  const [ready, setReady] = useState(false);
  const [localSaving, setSaving] = useState(false);
  const saving = localSaving || parent.state.botCreationPending;
  const savingRef = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState<"local" | null>(null);
  const [audience, setAudience] = useState<VisibilityMode>("everyone");
  const [people, setPeople] = useState("");
  const team = useTeamPeople();
  const teamName = parent.state.config?.team?.name;
  const [chosenOwner, setChosenOwner] = useState<string | null>(null);
  const ownerOrAdmin = useOwnerOrAdmin();
  const showThreads = useShowThreads();
  const sections = useAdvancedMode() ? SECTIONS : SECTIONS.filter((section) => section !== "Model");
  const choosesVisibility = !defaultsMode && typeof window !== "undefined" && !window.ogb && ownerOrAdmin === true;
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let cancelled = false;
    void api<BotDefaultsAnswer>("/api/bot-defaults")
      .then(result => {
        if (cancelled) return;
        const defaults = startingTemplate(result, !defaultsMode);
        const ready = defaultsMode || !readyBotId ? undefined : readyBot(readyBotId);
        const next = new BotCreationDraft(ready ? readyBotTemplate(defaults, ready) : defaults, () => render(value => value + 1));
        if (ready) next.role = ready.id;
        setDraft(next);
        setReady(true);
      }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [defaultsMode, readyBotId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => draft.dispose(), [draft]);
  // Disabling the focused Create button drops focus to the page in Chromium.
  useEffect(() => { if (saving) dialog.current?.focus(); }, [saving]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (!root || (event.target instanceof Node && !root.contains(event.target))) return;
      const nested = root.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      if (nested && nested.getClientRects().length) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')]
        .filter(control => control.getClientRects().length && !control.closest("[hidden],fieldset:disabled"));
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); root.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, []);
  const save = async () => {
    if (!ready || savingRef.current || parent.state.botCreationPending) return;
    if (!defaultsMode && draft.bot.approvalMode === "auto" && draft.bot.computer === "local" && !draft.consent.acknowledgeLocalAuto) { setWarning("local"); return; }
    const visibility = choosesVisibility ? visibilityFromForm(audience, people) : null;
    if (visibility && !visibility.ok) { setError(t("botSettings.visibility.needPeople")); return; }
    savingRef.current = true; setSaving(true); setError("");
    parent.dispatch({ type: "botCreationPending", on: true });
    try {
      if (defaultsMode) await api("/api/config", { method: "PATCH", body: JSON.stringify({ newBotDefaults: await preparedBotTemplate(draft) }) });
      else {
        const { bot, warnings } = await createConfiguredBot(draft, undefined, undefined, undefined, visibility?.ok ? visibility.visibility : undefined,
          team ? reportsToFor(chosenOwner, draft.bot.section, parent.state.bots, team) ?? undefined : undefined);
        announceNewBot(parent.dispatch, bot, warnings, { showThreads, source: draft.preset ? "preset" : draft.role ? "template" : "blank", role: draft.role });
        try { await onCreated?.(bot); }
        catch (cause) { parent.dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }); }
      }
      savingRef.current = false; if (alive.current) closeRef.current();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      savingRef.current = false;
      parent.dispatch({ type: "botCreationPending", on: false });
      if (alive.current) setSaving(false);
    }
  };
  const bot = draft.bot;
  const scopedStore: ReturnType<typeof useStore> = {
    ...parent,
    state: { ...parent.state, bots: [bot, ...parent.state.bots], routines: draft.routines, routineRuns: [], routinesLoadState: "ready" },
    flushBotPatches: async () => bot,
    dispatch: action => {
      if (action.type === "updateBot" && action.botId === draft.id) draft.patch(action.patch);
      else if (action.type === "setModel" && action.botId === draft.id) {
        draft.setModel(action.selection);
        if (action.resetApprovalToAsk) draft.patch({ approvalMode: "ask" });
      } else if (action.type === "routinePatched") {}
      else if (action.type === "toggleSettings") {}
      else parent.dispatch(action);
    },
  };
  const title = defaultsMode ? t("newBot.defaults") : t("sidebar.newBot");
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-5" hidden={!defaultsMode && parent.state.appSettingsOpen}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} aria-busy={saving} tabIndex={-1}
      className="flex h-[min(760px,94dvh)] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none">
      <div className="flex shrink-0 items-center justify-between border-b border-hairline/40 px-5 py-4">
        <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
        <button type="button" onClick={() => closeRef.current()} aria-label={t("common.close")}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"><X size={18} className="pointer-events-none" /></button>
      </div>
        {team && !defaultsMode && teamName && <SharedInTeam team={teamName} />}
        {choosesVisibility && (
          <div className="flex flex-wrap items-center gap-2 px-5 pt-3 text-[13px] text-ink-secondary" data-new-bot-visibility>
            <label className="flex items-center gap-2">
              {t("botSettings.visibility.title")}
              <Select size="sm"
                value={audience}
                disabled={saving}
                onChange={(event) => setAudience(event.target.value as VisibilityMode)}
              >
                <option value="everyone">{t("botSettings.visibility.everyone")}</option>
                <option value="admins">{t("botSettings.visibility.admins")}</option>
                <option value="people">{t("botSettings.visibility.people")}</option>
              </Select>
            </label>
            {audience === "people" && (
              <input
                value={people}
                disabled={saving}
                onChange={(event) => setPeople(event.target.value)}
                placeholder={t("botSettings.visibility.peoplePlaceholder")}
                aria-label={t("botSettings.visibility.peopleLabel")}
                className="min-w-[16rem] flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            )}
          </div>
        )}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label={t("newBot.sections")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline/40 p-2 sm:w-40 sm:flex-col sm:border-b-0 sm:border-r">
          {sections.map(label => <button key={label} type="button" onClick={() => setActive(label)} aria-current={active === label ? "page" : undefined}
            className={cn("shrink-0 rounded-lg px-3 py-2 text-left text-[13px]", active === label ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50")}>{t(SECTION_KEYS[label])}</button>)}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {!ready && !error && <div role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={16} className="animate-spin" />{t("newBot.loading")}</div>}
          {ready && <fieldset disabled={saving} className="min-w-0">
            <BotEditorStore value={scopedStore}><BotEditorContext.Provider value={{ request: draft.request, draft: true, uploadAvatar: draft.uploadAvatar }}>
              <DraftSection active={active} draft={draft} defaultsMode={defaultsMode}
                owner={team && !defaultsMode ? { value: reportsToFor(chosenOwner, bot.section, parent.state.bots, team), choose: setChosenOwner } : undefined} />
            </BotEditorContext.Provider></BotEditorStore>
          </fieldset>}
        </div>
      </div>
      {error && <p role="alert" className="max-h-24 overflow-y-auto border-t border-hairline/40 px-5 py-3 text-[13px] text-danger">{error}</p>}
      <div className="flex shrink-0 justify-end gap-2 border-t border-hairline/40 px-5 py-3">
        <button type="button" onClick={() => closeRef.current()} className="rounded-lg px-4 py-2 text-[13px] text-ink-secondary hover:bg-control">{t("common.cancel")}</button>
        <button type="button" disabled={!ready || saving || (!defaultsMode && !bot.name.trim())} onClick={() => void save()}
          className="ui-button-primary flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">
          {saving && <Loader2 size={15} className="animate-spin" />}{t(defaultsMode ? "newBot.saveDefaults" : "newBot.create")}
        </button>
      </div>
      <LocalComputerAutoWarning open={warning === "local"} onCancel={() => setWarning(null)} onConfirm={() => { draft.consent.acknowledgeLocalAuto = true; setWarning(null); void save(); }} />
    </div>
  </div>;
}

function SharedInTeam({ team }: { team: string }) {
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.workspaces;
  return <div data-new-bot-shared className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline/40 bg-raised/30 px-5 py-2.5 text-[13px] text-ink-secondary">
    <span>{t("newBot.sharedWith", { team })}</span>
    {bridge
      ? <button type="button" onClick={() => void openServerMenu(bridge).catch(() => {})} className="font-medium text-accent hover:underline">{t("newBot.justForYou")}</button>
      : <span>{t("newBot.justForYou").replace(/\s*→$/, "")}</span>}
  </div>;
}

function DraftSection({ active, draft, defaultsMode, owner }: { active: Section; draft: BotCreationDraft; defaultsMode: boolean;
  owner?: { value: string | null; choose(email: string): void } }) {
  const bot = draft.bot;
  const { state } = useStore();
  const team = useTeamPeople();
  const derived = useBotSettingsDerived(bot);
  if (active === "Identity") return <div className="space-y-4">
    <StartingRole draft={draft} defaultsMode={defaultsMode} />
    <IdentitySection bot={bot} patch={derived.patch} activeState={derived.activeState} mascotMotion={null}
      namePlaceholder={defaultsMode ? t("newBot.randomName") : undefined} />
    <label className="block text-[13px] text-ink-secondary">{t("newBot.team")}
      <Select size="lg" className="mt-1.5 w-full" value={bot.section ?? ""} onChange={event => draft.patch({ section: event.target.value })}>
        <option value="">{t("teamSettings.general")}</option>{[...new Set([...(state.sections ?? []), ...state.bots.map(bot => bot.section ?? "")])].filter(Boolean).map(name => <option key={name}>{name}</option>)}
      </Select>
    </label>
    {owner && team && <label className="block text-[13px] text-ink-secondary" data-new-bot-reports-to>{t("newBot.reportsTo")}
      <Select size="lg" className="mt-1.5 w-full" value={owner.value ?? ""} onChange={event => owner.choose(event.target.value)}>
        {team.people.map(person => <option key={person.email} value={person.email}>{person.you ? t("owner.you", { name: person.name }) : person.name}</option>)}
      </Select>
      <span className="mt-1 block text-[12px]">{t("owner.pickHint")}</span>
    </label>}
  </div>;
  if (active === "Soul") return <SoulSection bot={bot} patch={derived.patch} />;
  if (active === "Skills") return <SkillsSection bot={bot} />;
  if (active === "Memory") return <DraftMemory draft={draft} />;
  if (active === "Routines") return <DraftRoutines draft={draft} />;
  if (active === "Access") return <AccessSection bot={bot} derived={derived} />;
  if (active === "Model") return <ModelSection bot={bot} />;
  if (active === "Permissions") return <PermissionsSection bot={bot} derived={derived} />;
  return <VoiceSection bot={bot} derived={derived} />;
}

function StartingRole({ draft, defaultsMode }: { draft: BotCreationDraft; defaultsMode: boolean }) {
  const [presets, setPresets] = useState<BotPreset[]>([]);
  const [loads, setLoads] = useState(0);
  const [error, setError] = useState("");
  const presetPicture = useRef(false);
  useEffect(() => {
    if (defaultsMode) return;
    let cancelled = false;
    void api<{ presets: BotPreset[] }>("/api/bot-presets")
      .then(result => { if (!cancelled) setPresets(result.presets); })
      .catch(() => { if (!cancelled) setPresets([]); });
    return () => { cancelled = true; };
  }, [defaultsMode, loads]);
  const chosen = draft.preset ? presets.find(preset => preset.id === draft.preset!.id) : undefined;
  const choose = async (value: string) => {
    setError("");
    const preset = value.startsWith("preset:") ? presets.find(candidate => candidate.id === value.slice("preset:".length)) : undefined;
    if (!preset) {
      draft.choosePreset(undefined);
      const role = BOT_ROLES.find(role => role.id === value);
      draft.chooseRole(role?.id);
      const look = role && readyBot(role.id)?.look;
      if (role) draft.patch({ ...roleProfilePatch(role), ...look });
      return;
    }
    draft.patch(presetDraftPatch(preset));
    draft.choosePreset(chosenPreset(preset));
    const picture = presetPictureFile(preset);
    try {
      if (picture) {
        draft.patch({ avatarUrl: await draft.uploadAvatar(picture), avatarCrop: preset.bot.appearance!.avatar!.crop });
        presetPicture.current = true;
      } else if (presetPicture.current) {
        draft.patch({ avatarUrl: "" });
        presetPicture.current = false;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const remove = async (preset: BotPreset) => {
    setError("");
    try {
      await api(`/api/bot-presets/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
      if (draft.preset?.id === preset.id) draft.choosePreset(undefined);
      setLoads(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const roles = BOT_ROLES.map(role => <option key={role.id} value={role.id}>{role.title}</option>);
  return <div>
    <label className="block text-[13px] text-ink-secondary">{t("newBot.startingRole")}
      <Select size="lg" className="mt-1.5 w-full" value={draft.preset ? `preset:${draft.preset.id}` : ""} onChange={event => void choose(event.target.value)}>
        <option value="">{t("newBot.customSettings")}</option>
        {presetGroups(presets).map(group => <optgroup key={group.label} label={group.label}>
          {group.presets.map(preset => <option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}
        </optgroup>)}
        {presets.length ? <optgroup label={t("newBot.builtInRoles")}>{roles}</optgroup> : roles}
      </Select>
    </label>
    {chosen && <div className="mt-2 space-y-1 rounded-lg bg-card px-3 py-2.5 text-[13px] text-ink-secondary" data-new-bot-preset>
      {presetSummaryLines(chosen).map((line, index) => <p key={index} className="break-words">{line}</p>)}
      {chosen.source === "file" && <button type="button" onClick={() => void remove(chosen)}
        className="mt-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">{t("newBot.presetRemove")}</button>}
    </div>}
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
  </div>;
}

function DraftMemory({ draft }: { draft: BotCreationDraft }) {
  const [path, setPath] = useState("MEMORY.md");
  const [name, setName] = useState("");
  return <div className="space-y-3">
    <Select size="lg" className="w-full" aria-label={t("memory.fileLabel", { path })} value={path} onChange={event => setPath(event.target.value)}>
      {[...new Set(["MEMORY.md", ...Object.keys(draft.template.memory)])].map(file => <option key={file}>{file}</option>)}
    </Select>
    <textarea className={cn(inputCls, "min-h-72 font-mono")} aria-label={t("memory.contents")} value={draft.template.memory[path] ?? ""} onChange={event => draft.setMemory(path, event.target.value)} />
    <div className="flex gap-2"><input className={inputCls} aria-label={t("memory.newTopicLabel")} placeholder={t("memory.newTopicLabel")} value={name} onChange={event => setName(event.target.value)} />
      <button type="button" aria-label={t("memory.addTopic")} disabled={!/^[a-zA-Z0-9_-]+$/.test(name)} className="rounded-lg bg-control px-3 disabled:opacity-40" onClick={() => { const next = `memory/${name}.md`; if (!(next in draft.template.memory)) draft.setMemory(next, ""); setPath(next); setName(""); }}><Plus size={16} /></button>
      {path !== "MEMORY.md" && <button type="button" aria-label={t("memory.removeTopic")} className="rounded-lg bg-control px-3" onClick={() => { draft.setMemory(path, null); setPath("MEMORY.md"); }}><Trash2 size={16} /></button>}
    </div>
  </div>;
}

function DraftRoutines({ draft }: { draft: BotCreationDraft }) {
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  return <div className="space-y-3">
    <button type="button" className="rounded-lg bg-accent px-3 py-2 text-[13px] text-white" onClick={() => setEditing("new")}>{t("computer.routines.create")}</button>
    {draft.routines.map(routine => <div key={routine.id} className="flex items-center gap-2 rounded-lg bg-card p-3">
      <button type="button" className="min-w-0 flex-1 text-left text-[13px]" onClick={() => setEditing(routine)}>{routine.name}</button>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary"><input type="checkbox" checked={routine.enabled} onChange={event => draft.setRoutineEnabled(routine.id, event.target.checked)} />{t("newBot.enabled")}</label>
      <button type="button" aria-label={t("newBot.removeRoutine", { name: routine.name })} onClick={() => draft.removeRoutine(routine.id)} className="rounded p-1.5 hover:bg-control"><Trash2 size={15} /></button>
    </div>)}
    {editing && <RoutineEditor routine={editing === "new" ? undefined : editing} bots={[draft.bot]} lockedBotId={draft.id} onClose={() => setEditing(null)} />}
  </div>;
}

export function DefaultBotSettings() {
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);

    const content = <>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={() => setSharing(true)} className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">{t("newBot.sharePreset")}</button>
        <button type="button" onClick={() => setOpen(true)} className="cursor-pointer rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover">{t("newBot.edit")}</button>
      </div>
      {open && <NewBotDialog defaultsMode onClose={() => setOpen(false)} />}
      {sharing && <SharePresetDialog onClose={() => setSharing(false)} />}
    </>

  return <>
    <SettingRow title={t("newBot.defaults")} children={content} />

  </>;
}
