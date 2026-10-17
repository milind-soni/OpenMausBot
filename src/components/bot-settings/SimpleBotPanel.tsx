         import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, FileText, Image as ImageIcon, Slack, Smartphone, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";
import { attachmentBasename } from "@/lib/composer-attachments";
import { friendlyEffort, simpleEffortLevels } from "@/lib/model-friendly";
import type { Place } from "@/lib/place";
import { placeFacts, placeHasIssue, placeViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import { routineFinished, routineNextLabel } from "@/lib/routine-display";
import { scheduleLabel } from "@/lib/schedule-label";
import { firstSentence } from "@/lib/soul";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import type { ApprovalMode } from "../../../shared/approval-mode";
import type { EffortLevel } from "../../../shared/wire";
import { approvalModeOptionsFor } from "../ApprovalModeSelector";
import { collectMessageFiles, splitMessageAttachments } from "../AttachmentGallery";
import { BotAvatar } from "../Avatar";
import { BotProfileAvatarCard } from "../BotProfileAvatarCard";
import { useCaptionChrome, useDesktopCapabilities } from "../DesktopCapabilities";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { ModelPicker } from "../ModelPicker";
import { PhoneAppDialog } from "../PhoneAppDialog";
import { usePlaceViews } from "../PlaceChip";
import { ServiceIcon } from "../PluginsPanel";
import { ThreadModelsLine } from "../ThreadModelsLine";
import { Switch } from "../SettingsPrimitives";
import { SoulField } from "../SoulField";
import { MemorySection } from "./MemorySection";
import { RoutinesSection } from "./RoutinesSection";
import { SkillReviewDialog, useManagedSkills } from "./SkillsSection";
import { useBotApps } from "./useBotApps";
import type { BotPatch, useBotSettingsDerived } from "./useBotSettingsDerived";
import { VaultTab } from "./VaultTab";

export const simpleInputCls =
  "w-full rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-tertiary focus:border-accent-border focus:outline-none";

const labelCls = "mb-1.5 block text-[12px] text-ink-secondary";

export type SimpleBotTab = "details" | "memory" | "library" | "skills" | "routines" | "vault";

 const TABS = [
  ["details", "botSettings.simple.details"],
  ["memory", "botSettings.simple.memory"],
  ["library", "botSettings.simple.library"],
  ["skills", "botSettings.simple.skills"],
  ["routines", "botSettings.simple.routines"],
  ["vault", "botSettings.simple.vault"],
] as const;

 const SIMPLE_PLACES: readonly Place[] = ["local", "cloud"];

 const USES_SHOWN = 4;

const rowsCls = "divide-y divide-hairline/40 border-y border-hairline/40";
const sectionTitleCls = "text-[12px] text-ink-secondary";
 const rowActionCls = "flex shrink-0 items-center gap-0.5 rounded-md py-1 pl-2 pr-1 text-[13px] font-medium text-ink hover:bg-raised";
const linkCls = "rounded-md px-1.5 py-0.5 text-[12px] font-medium text-accent-text hover:bg-raised";
 const segmentCls = "inline-flex shrink-0 rounded-full bg-inset p-0.5";
const segmentItemCls = (on: boolean) =>
  cn(
    "rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    on ? "bg-raised text-ink shadow-sm" : "text-ink-secondary enabled:hover:text-ink",
  );

 function Row({ title, hint, badge, children, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  badge?: ReactNode;
  children?: ReactNode;
  "data-simple-row"?: string;
}) {
  return (
    <div {...rest} className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 py-3.5">
      <div className="min-w-[7.5rem] flex-1">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
          <span className="min-w-0 truncate">{title}</span>
          {badge}
        </div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export interface LibraryItem {
  key: string;
  name: string;
  kind: "image" | "file";
  at: number;
  messageId: string;
}

 export function botLibraryItems(bot: Bot): LibraryItem[] {
  const groups: LibraryItem[][] = [];
  const seen = new Set<string>();
  for (const message of [...visibleMessages(bot)].reverse()) {
    const items: LibraryItem[] = [];
    groups.push(items);
    if (message.role !== "bot" || message.kind !== "text") continue;
    const attached = splitMessageAttachments(message.attachments);
    const files = [
      ...attached.files,
      ...collectMessageFiles(message.text ?? "", [...attached.images, ...attached.files.map((file) => file.path)]),
    ];
    const add = (path: string, name: string, kind: LibraryItem["kind"]) => {
      if (seen.has(path)) return;
      seen.add(path);
      items.push({ key: `${message.id}:${path}`, name, kind, at: message.at, messageId: message.id });
    };
    for (const image of attached.images) add(image, attachmentBasename(image), "image");
    for (const file of files) add(file.path, file.name || attachmentBasename(file.path), "file");
  }
  return groups.flat();
}

export function SimpleBotPanel({
  bot,
  derived,
  headerClassName,
  slackUrl = null,
  onClose,
  onAllSettings,
  onAddSkill,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  headerClassName?: string;
  slackUrl?: string | null;
  onClose: () => void;
  onAllSettings: () => void;
  onAddSkill: () => void;
}) {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const [tab, setTab] = useState<SimpleBotTab>("details");
  const [localAutoWarning, setLocalAutoWarning] = useState<{ botId: string; patch: BotPatch } | null>(null);
  const linked = state.botSettingsExpandAccordion && !state.botSettingsExpandRemembered
    && (state.botSettingsSection === "identity" || state.botSettingsSection === "soul") ? state.botSettingsSection : null;
  const [editing, setEditing] = useState<"look" | "identity" | "soul" | null>(linked);
  useEffect(() => {
    if (!linked) return;
    setTab("details");
    setEditing(linked);
  }, [linked]);
  const [memoryShown, setMemoryShown] = useState(false);
  const [phoneAppOpen, setPhoneAppOpen] = useState(false);
  const skills = useManagedSkills(bot);
  const apps = useBotApps(bot);
  const { capabilities } = useDesktopCapabilities();
  const platform = capabilities.host?.platform ?? "other";
  const placeSeat = usePlaceSeat(state.config, platform);
  const { patch, approvalMode, engine, trustedModesAvailable } = derived;
  const displayedApprovalMode = engine?.driverKind === "antigravityAgent" && approvalMode === "auto" ? "ask" : approvalMode;

  const autoOffered = approvalModeOptionsFor(engine?.driverKind ?? "", trustedModesAvailable)
    .some((option) => option.mode === "auto");
  const chooseMode = (mode: Extract<ApprovalMode, "ask" | "auto" | "full">) => {
    if (mode === approvalMode) return;
    if (mode === "full") {
      dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: "full", applyToAllThreads: true } });
      return;
    }
    if (mode === "auto" && bot.computer === "local") {
      setLocalAutoWarning({ botId: bot.id, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
      return;
    }
    patch({ approvalMode: mode });
  };
  const customMode = displayedApprovalMode === "edits" || displayedApprovalMode === "custom";

  const effortLevels = engine?.capabilities?.modelVariants ? [] : engine?.capabilities?.effortLevels ?? [];
  const thinkingLevels = effortLevels.length > 0 ? simpleEffortLevels(effortLevels, bot.modelSelection.effort) : [];
  const chooseEffort = (level: EffortLevel) => {
    if (bot.busy || level === bot.modelSelection.effort) return;
    dispatch({ type: "setModel", botId: bot.id, selection: { ...bot.modelSelection, effort: level } });
  };

  const worksOn = placeViewFor(placeFacts({
    bot, place: bot.computer ?? "auto", seat: placeSeat, config: state.config, instances: state.instances,
  }));
  const placeViews = usePlaceViews(bot);
  const currentPlace = bot.computer ?? "auto";
  const placeChoices: { value: "auto" | Place; label: string; disabled: boolean; title?: string }[] = [
    { value: "auto", label: worksOnSimpleLabel(undefined, platform), disabled: false },
    ...SIMPLE_PLACES.filter((place) => placeViews[place].policy).map((place) => {
      const { view, reachable } = placeViews[place];
      return { value: place, label: worksOnSimpleLabel(place, platform), disabled: !reachable, title: !reachable || placeHasIssue(view) ? view.line : undefined };
    }),
  ];
  const placeListed = placeChoices.some((choice) => choice.value === currentPlace);
  const choosePlace = (value: "auto" | Place) => {
    if (value === currentPlace) return;
    if (value === "local" && approvalMode === "auto") {
      setLocalAutoWarning({ botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
      return;
    }
    patch({ computer: value === "auto" ? null : value });
  };
  const openBrowser = () => {
    writeComputerPanelView(bot.id, "browser");
    dispatch({ type: "toggleComputer", open: true });
  };

  const usedApps = apps.apps.filter((app) => app.scope !== null);
  const routines = [...derived.botRoutines].sort((a, b) =>
    Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name));
  const soulOpen = editing === "soul" || Boolean(bot.soulDrift);

  const library = useMemo(() => (tab === "library" ? botLibraryItems(bot) : []), [tab, bot]);

  const showTab = (next: SimpleBotTab) => {
    if (next === "memory") setMemoryShown(true);
    setTab(next);
  };
  const changeLook = () => {
    setTab("details");
    setEditing("look");
  };
  const tabCls = (active: boolean) =>
    cn(
      "min-w-0 flex-1 truncate rounded-full px-0.5 py-1.5 text-[12.5px] font-medium transition-colors @max-[22rem]:text-[11.5px] @max-[19.5rem]:text-[11px]",
      active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
    );
  const soon = (
    <span className="shrink-0 rounded-full bg-control px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary">
      {t("botSettings.simple.soon")}
    </span>
  );

  return (
    <>
      <div {...dragProps} className={cn("flex shrink-0 items-center justify-end px-4 py-3", headerClassName)}>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("botSettings.simple.close")}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} className="pointer-events-none" />
        </button>
      </div>

      <div className="@container flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            data-simple-avatar
            onClick={changeLook}
            aria-label={t("botSettings.simple.changeLook", { name: bot.name })}
            title={t("botSettings.simple.changeLook", { name: bot.name })}
            className="rounded-2xl transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border motion-reduce:transition-none motion-reduce:hover:scale-100"
          >
            <BotAvatar bot={bot} size={72} state={derived.activeState} />
          </button>
          <h2 id="bot-settings-title" className="max-w-full truncate text-[17px] font-semibold text-ink">
            {bot.name}
          </h2>
        </div>

        <div role="tablist" aria-label={t("botSettings.simple.tabs")} className="mt-4 flex shrink-0 rounded-full bg-inset p-1">
          {TABS.map(([id, labelKey]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-simple-tab={id}
              onClick={() => showTab(id)}
              className={tabCls(tab === id)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {tab === "details" && (
          <div role="tabpanel" className="mt-5 flex flex-col gap-6">
            <div className={rowsCls}>
              {/* The same editor Identity has under All settings: color, body,
                  expression, or a picture of the person's own. */}
              {editing === "look" ? (
                <div className="py-3.5" data-simple-row="look">
                  <BotProfileAvatarCard bot={bot} activeState={derived.activeState} mascotMotion={derived.mascotMotion ?? null} onPatch={patch} />
                  <div className="mt-2 flex justify-end">
                    <button type="button" data-simple-done="look" onClick={() => setEditing(null)} className={linkCls}>
                      {t("botSettings.simple.done")}
                    </button>
                  </div>
                </div>
              ) : (
                <Row data-simple-row="look" title={t("botSettings.simple.look")} hint={t("botSettings.simple.lookHint")}>
                  <button
                    type="button"
                    data-simple-edit="look"
                    aria-label={`${t("botSettings.simple.edit")}: ${t("botSettings.simple.look")}`}
                    onClick={() => setEditing("look")}
                    className={rowActionCls}
                  >
                    {t("botSettings.simple.edit")}
                    <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                  </button>
                </Row>
              )}

              {editing === "identity" ? (
                <div className="py-3.5" data-simple-row="identity">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="min-w-0">
                      <label htmlFor={`simple-bot-name-${bot.id}`} className={labelCls}>{t("botSettings.simple.name")}</label>
                      <input
                        id={`simple-bot-name-${bot.id}`}
                        className={simpleInputCls}
                        maxLength={BOT_PROFILE_LIMITS.name}
                        value={bot.name}
                        onChange={(e) => patch({ name: e.target.value })}
                      />
                    </div>
                    <div className="min-w-0">
                      <label htmlFor={`simple-bot-job-${bot.id}`} className={labelCls}>{t("botSettings.simple.job")}</label>
                      <input
                        id={`simple-bot-job-${bot.id}`}
                        className={simpleInputCls}
                        maxLength={BOT_PROFILE_LIMITS.title}
                        placeholder={t("botSettings.simple.jobPlaceholder")}
                        value={bot.title}
                        onChange={(e) => patch({ title: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="mt-2 flex justify-end">
                    <button type="button" data-simple-done="identity" onClick={() => setEditing(null)} className={linkCls}>
                      {t("botSettings.simple.done")}
                    </button>
                  </div>
                </div>
              ) : (
                <Row
                  data-simple-row="identity"
                  title={t("botSettings.simple.nameAndJob")}
                  hint={bot.title.trim() ? `${bot.name} · ${bot.title.trim()}` : bot.name}
                >
                  <button
                    type="button"
                    data-simple-edit="identity"
                    aria-label={`${t("botSettings.simple.edit")}: ${t("botSettings.simple.nameAndJob")}`}
                    onClick={() => setEditing("identity")}
                    className={rowActionCls}
                  >
                    {t("botSettings.simple.edit")}
                    <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                  </button>
                </Row>
              )}

              {soulOpen ? (
                <div className="py-3.5" data-simple-row="soul">
                  <SoulField
                    bot={bot}
                    onPatch={patch}
                    simple={{
                      label: t("botSettings.simple.instructions"),
                      placeholder: t("botSettings.simple.instructionsPlaceholder", { name: bot.name }),
                    }}
                  />
                  {editing === "soul" && (
                    <div className="mt-2 flex justify-end">
                      <button type="button" data-simple-done="soul" onClick={() => setEditing(null)} className={linkCls}>
                        {t("botSettings.simple.done")}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <Row
                  data-simple-row="soul"
                  title={t("botSettings.simple.instructions")}
                  hint={<span className="line-clamp-2">{firstSentence(bot.soul ?? "") || t("botSettings.simple.noInstructions")}</span>}
                >
                  <button
                    type="button"
                    data-simple-edit="soul"
                    aria-label={`${t("botSettings.simple.edit")}: ${t("botSettings.simple.instructions")}`}
                    onClick={() => setEditing("soul")}
                    className={rowActionCls}
                  >
                    {t("botSettings.simple.edit")}
                    <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                  </button>
                </Row>
              )}

              {/* The bot's model, in the same plain-words picker as the chat
                  header, shown in place (a floating popover would be clipped by
                  this scrolling panel). A pick is the bot's model: groups and
                  every thread without its own model move with it, like the full
                  Model section, and the line below counts the threads that don't. */}
              {/* The Thinking row below carries the effort steps, so the picker's
                  own copy of that band is hidden while the row is shown: two
                  copies of one control in one view read as a bug. The picker is
                  not asked to leave it out because its file is at its size
                  ceiling (scripts/testing/file-size-ratchet.test.ts). */}
              <div
                className={cn("py-3.5", thinkingLevels.length > 0 && "[&_[data-simple-effort]]:hidden")}
                data-simple-default-model
              >
                <ModelPicker
                  bot={bot}
                  contained
                  label={<span className="text-[13.5px] font-semibold text-ink">{t("botSettings.simple.defaultModel")}</span>}
                />
                <ThreadModelsLine bot={bot} className="mt-2" />
              </div>

              {thinkingLevels.length > 0 && (
                <Row
                  data-simple-row="thinking"
                  title={t("botSettings.simple.thinking")}
                  hint={t(bot.modelSelection.effort === undefined ? "botSettings.simple.thinkingDefault" : "botSettings.simple.thinkingHint")}
                >
                  <div role="group" aria-label={t("botSettings.simple.thinkingAria", { name: bot.name })} className={segmentCls}>
                    {thinkingLevels.map((level) => (
                      <button
                        key={level}
                        type="button"
                        data-thinking-choice={level}
                        aria-pressed={bot.modelSelection.effort === level}
                        disabled={Boolean(bot.busy)}
                        onClick={() => chooseEffort(level)}
                        className={segmentItemCls(bot.modelSelection.effort === level)}
                      >
                        {friendlyEffort(level)}
                      </button>
                    ))}
                  </div>
                </Row>
              )}

              <Row
                data-simple-row="approval"
                title={t("botSettings.simple.beforeActs", { name: bot.name })}
                hint={customMode
                  ? <span data-approval-custom>{t("botSettings.simple.customMode")}</span>
                  : t(displayedApprovalMode === "auto" ? "botSettings.simple.decideHint"
                    : displayedApprovalMode === "full" ? "botSettings.simple.fullHint" : "botSettings.simple.askHint")}
              >
                <div role="group" aria-label={t("botSettings.simple.beforeActs", { name: bot.name })} className={segmentCls}>
                  {([
                    { mode: "ask", title: t("botSettings.simple.ask"), hint: t("botSettings.simple.askHint"), offered: true },
                    { mode: "auto", title: t("botSettings.simple.decide"), hint: t("botSettings.simple.decideHint"), offered: autoOffered },
                    { mode: "full", title: t("botSettings.simple.full"), hint: t("botSettings.simple.fullHint"), offered: true },
                  ] as const).map((choice) => {
                    const selected = displayedApprovalMode === choice.mode;
                    return (
                      <button
                        key={choice.mode}
                        type="button"
                        data-approval-choice={choice.mode}
                        aria-pressed={selected}
                        title={choice.hint}
                        disabled={!choice.offered}
                        onClick={() => chooseMode(choice.mode)}
                        className={segmentItemCls(selected)}
                      >
                        {choice.title}
                      </button>
                    );
                  })}
                </div>
              </Row>

              <Row
                data-simple-row="computer"
                title={t("computer.simple.whereWorks", { name: bot.name })}
                hint={currentPlace === "auto" ? t("place.autoDetail")
                  : placeListed ? worksOn.line : `${worksOnSimpleLabel(bot.computer, platform)}: ${worksOn.line}`}
              >
                <div role="group" aria-label={t("computer.simple.whereWorks", { name: bot.name })} className={segmentCls}>
                  {placeChoices.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      data-place-choice={choice.value}
                      aria-pressed={choice.value === currentPlace}
                      disabled={choice.disabled}
                      title={choice.title}
                      onClick={() => choosePlace(choice.value)}
                      className={segmentItemCls(choice.value === currentPlace)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </Row>

              <Row
                data-simple-row="uses"
                title={t("botSettings.simple.uses")}
                hint={usedApps.length > 0 ? (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {usedApps.slice(0, USES_SHOWN).map((app) => (
                      <span key={app.slug} data-simple-uses={app.slug} className="inline-flex max-w-full items-center gap-1 rounded-full bg-control py-0.5 pl-1 pr-2 text-[11.5px] text-ink">
                        {/* Keyed by its mark: the catalog can arrive after the list. */}
                        <ServiceIcon key={`${app.card.logo}:${app.card.domain}`} card={app.card} className="size-3.5 shrink-0 text-[8px]" />
                        <span className="truncate">{app.label}</span>
                      </span>
                    ))}
                    {usedApps.length > USES_SHOWN && (
                      <span className="rounded-full px-1 py-0.5 text-[11.5px] text-ink-secondary">
                        {t("botSettings.simple.usesMore", { count: usedApps.length - USES_SHOWN })}
                      </span>
                    )}
                  </span>
                ) : apps.phase === "loading" ? t("common.checking") : t("botSettings.simple.usesNone")}
              >
                <button
                  type="button"
                  data-simple-open-tab="vault"
                  aria-label={`${t("botSettings.simple.open")}: ${t("botSettings.simple.vault")}`}
                  onClick={() => showTab("vault")}
                  className={rowActionCls}
                >
                  {t("botSettings.simple.vault")}
                  <ChevronRight size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                </button>
              </Row>

              {/* A bot's own number and inbox are on their way; the rows say so
                  rather than appear one day with no warning. */}
              <Row data-simple-row="phone" title={t("botSettings.simple.phone")} badge={soon} hint={t("botSettings.simple.phoneHint")} />
              <Row data-simple-row="email" title={t("botSettings.simple.email")} badge={soon} hint={t("botSettings.simple.emailHint")} />
            </div>

            <section data-simple-routines>
              <div className="mb-1 flex min-h-7 items-center justify-between gap-3">
                <h3 className={sectionTitleCls}>{t("botSettings.simple.routines")}</h3>
                <button
                  type="button"
                  data-simple-open-tab="routines"
                  aria-label={`${t("botSettings.simple.open")}: ${t("botSettings.simple.routines")}`}
                  onClick={() => showTab("routines")}
                  className={linkCls}
                >
                  {t("botSettings.simple.open")}
                </button>
              </div>
              {routines.length === 0 ? (
                <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("botSettings.simple.routinesEmpty", { name: bot.name })}</p>
              ) : (
                <div className={rowsCls}>
                  {routines.map((routine) => (
                    <div key={routine.id} data-simple-routine={routine.id} className="flex items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold text-ink">{routine.name}</div>
                        <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">
                          {scheduleLabel(routine.schedule)} · {routineNextLabel(routine)}
                        </div>
                      </div>
                      {/* A finished one-shot has nothing left to switch on. */}
                      {!routineFinished(routine) && (
                        <Switch
                          checked={routine.enabled}
                          aria-label={t("routines.toggle", { name: routine.name })}
                          onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: !routine.enabled } })}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section data-simple-where>
              <h3 className={cn(sectionTitleCls, "mb-2")}>{t("botSettings.simple.whereToFind", { name: bot.name })}</h3>
              <div className={cn("grid gap-2", slackUrl ? "grid-cols-3" : "grid-cols-2")}>
                {([["ios", "phoneApp.ios"], ["android", "phoneApp.android"]] as const).map(([id, nameKey]) => (
                  <button
                    key={id}
                    type="button"
                    data-simple-find={id}
                    onClick={() => setPhoneAppOpen(true)}
                    className="flex min-w-0 flex-col items-start gap-0.5 rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-left hover:bg-raised"
                  >
                    <Smartphone size={16} className="mb-1 shrink-0 text-ink-secondary" aria-hidden="true" />
                    <span className="max-w-full truncate text-[13px] font-medium text-ink">{t(nameKey)}</span>
                    <span className="max-w-full truncate text-[11.5px] text-ink-secondary">{t("botSettings.simple.getApp")}</span>
                  </button>
                ))}
                {slackUrl && (
                  <a
                    href={slackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-simple-find="slack"
                    className="flex min-w-0 flex-col items-start gap-0.5 rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-left hover:bg-raised"
                  >
                    <Slack size={16} className="mb-1 shrink-0 text-ink-secondary" aria-hidden="true" />
                    <span className="max-w-full truncate text-[13px] font-medium text-ink">Slack</span>
                    <span className="max-w-full truncate text-[11.5px] text-ink-secondary">{t("botSettings.simple.slackHint")}</span>
                  </a>
                )}
              </div>
            </section>

            <button
              type="button"
              data-simple-all-settings
              onClick={onAllSettings}
              className="flex items-center gap-2 rounded-xl border border-dashed border-hairline px-4 py-3 text-left text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-ink">{t("botSettings.simple.allSettings")}</span>
                {" — "}
                {t("botSettings.simple.allSettingsHint")}
              </span>
              <ChevronRight size={15} className="shrink-0" />
            </button>
          </div>
        )}

        {memoryShown && (
          <div role="tabpanel" className="mt-5" hidden={tab !== "memory"}>
            <MemorySection bot={bot} active={tab === "memory"} onToggle={(enabled) => patch({ memoryEnabled: enabled })} />
          </div>
        )}

        {tab === "library" && (
          <div role="tabpanel" className="mt-5">
            {library.length === 0 ? (
              <div className="px-4 py-12 text-center text-[13px] leading-relaxed text-ink-secondary">
                {t("botSettings.simple.libraryEmpty", { name: bot.name })}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {library.map((item) => {
                  const Icon = item.kind === "image" ? ImageIcon : FileText;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-library-item={item.messageId}
                      title={t("botSettings.simple.libraryOpen", { name: item.name })}
                      onClick={() => dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: item.messageId })}
                      className="flex items-center gap-3 rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-left hover:bg-raised"
                    >
                      <Icon size={16} className="shrink-0 text-ink-secondary" />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{item.name}</span>
                      <span className="shrink-0 text-[12px] text-ink-tertiary">
                        {new Date(item.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "skills" && (
          <div role="tabpanel" className="mt-5">
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className={sectionTitleCls}>{t("botSettings.simple.skills")}</span>
              <button type="button" data-simple-add-skill onClick={onAddSkill} className={linkCls}>
                {t("botSettings.simple.addSkill")}
              </button>
            </div>
            {!skills.loading && skills.skills.length === 0 ? (
              <div className="text-[12.5px] text-ink-tertiary">{t("botSettings.simple.noSkills")}</div>
            ) : (
              <div className={rowsCls}>
                {skills.skills.map((skill) => (
                  <div key={skill.name} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold text-ink">{skill.name}</div>
                      <div className="truncate text-[12.5px] text-ink-secondary">{skill.description || skill.source}</div>
                    </div>
                    <Switch
                      checked={skill.enabled}
                      aria-label={t("botSettings.simple.skillToggle", { name: skill.name })}
                      disabled={Boolean(skills.working)}
                      onClick={() => void skills.toggle(skill)}
                    />
                  </div>
                ))}
              </div>
            )}
            {skills.error && !skills.reviewing && (
              <div role="alert" className="mt-2 text-[12px] text-danger">{skills.error}</div>
            )}
            <p className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">{t("botSettings.simple.skillsHint", { name: bot.name })}</p>
          </div>
        )}

        {tab === "routines" && (
          <div role="tabpanel" className="mt-5">
            <RoutinesSection bot={bot} routines={derived.botRoutines} runs={state.routineRuns} />
          </div>
        )}

        {tab === "vault" && (
          <VaultTab bot={bot} derived={derived} apps={apps} onOpenBrowser={openBrowser} />
        )}
      </div>

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
      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target.botId, patch: target.patch });
        }}
      />
      {/* Where the phone apps are. Pairing a phone stays in the profile menu. */}
      <PhoneAppDialog open={phoneAppOpen} onClose={() => setPhoneAppOpen(false)} />
    </>
  );
}
