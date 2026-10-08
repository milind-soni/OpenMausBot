// The bot settings panel in Simple mode: the bot's face, then two tabs.
// Details holds the handful of things a non-technical person changes (name,
// job, instructions, how much it decides alone, skills); Library lists what
// the bot has made in this chat. Every field writes through the same path the
// full fold-out sections use, and "All settings" opens that full view.
import { useMemo, useState } from "react";
import { ChevronRight, FileText, Image as ImageIcon, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { attachmentBasename } from "@/lib/composer-attachments";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import type { ApprovalMode } from "../../../shared/approval-mode";
import { approvalModeOptionsFor } from "../ApprovalModeSelector";
import { collectMessageFiles, splitMessageAttachments } from "../AttachmentGallery";
import { BotAvatar } from "../Avatar";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { ModelPicker } from "../ModelPicker";
import { ThreadModelsLine } from "../ThreadModelsLine";
import { Switch } from "../SettingsPrimitives";
import { SoulField } from "../SoulField";
import { SkillReviewDialog, useManagedSkills } from "./SkillsSection";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

export const simpleInputCls =
  "w-full rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-tertiary focus:border-accent-border focus:outline-none";

const labelCls = "mb-1.5 block text-[12px] text-ink-secondary";

export interface LibraryItem {
  key: string;
  name: string;
  kind: "image" | "file";
  at: number;
  messageId: string;
}

/** What the bot has made in its open conversation: images and files it
 * attached, plus local files its replies link to — the same set the chat's
 * attachment gallery shows under each message. Newest first. */
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
  // Newest message first; a message's own files keep the order it gave them.
  return groups.flat();
}

export function SimpleBotPanel({
  bot,
  derived,
  headerClassName,
  onClose,
  onAllSettings,
  onAddSkill,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  /** The caption-button inset the full panel's header uses on Windows. */
  headerClassName?: string;
  onClose: () => void;
  onAllSettings: () => void;
  onAddSkill: () => void;
}) {
  const { dispatch } = useStore();
  const [tab, setTab] = useState<"details" | "library">("details");
  const [localAutoWarning, setLocalAutoWarning] = useState<string | null>(null);
  const skills = useManagedSkills(bot);
  const { patch, approvalMode, engine, trustedModesAvailable } = derived;
  // Match the full selector: old Antigravity Auto still executes as Ask.
  // Display that behavior without changing the saved mode or granting Full.
  const displayedApprovalMode = engine?.driverKind === "antigravityAgent" && approvalMode === "auto" ? "ask" : approvalMode;

  // Ask is always offered; "Decide for me" is the provider's own Auto, which
  // a few engines do not have.
  const autoOffered = approvalModeOptionsFor(engine?.driverKind ?? "", trustedModesAvailable)
    .some((option) => option.mode === "auto");
  const chooseMode = (mode: Extract<ApprovalMode, "ask" | "auto">) => {
    // The same rules as the Permissions section's selector: no change while
    // a turn runs, and Auto on this computer needs its warning first.
    if (bot.busy || mode === approvalMode) return;
    if (mode === "auto" && bot.computer === "local") {
      setLocalAutoWarning(bot.id);
      return;
    }
    patch({ approvalMode: mode });
  };
  const customMode = displayedApprovalMode !== "ask" && displayedApprovalMode !== "auto";

  const library = useMemo(() => (tab === "library" ? botLibraryItems(bot) : []), [tab, bot]);

  const tabCls = (active: boolean) =>
    cn(
      "rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
      active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
    );

  return (
    <>
      <div className={cn("flex shrink-0 items-center justify-end px-4 py-3", headerClassName)}>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("botSettings.simple.close")}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} className="pointer-events-none" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center gap-2">
          <BotAvatar bot={bot} size={72} state={derived.activeState} />
          <h2 id="bot-settings-title" className="max-w-full truncate text-[17px] font-semibold text-ink">
            {bot.name}
          </h2>
        </div>

        <div className="mt-4 flex justify-center">
          <div role="tablist" aria-label={t("botSettings.simple.tabs")} className="inline-flex rounded-full bg-inset p-1">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "details"}
              data-simple-tab="details"
              onClick={() => setTab("details")}
              className={tabCls(tab === "details")}
            >
              {t("botSettings.simple.details")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "library"}
              data-simple-tab="library"
              onClick={() => setTab("library")}
              className={tabCls(tab === "library")}
            >
              {t("botSettings.simple.library")}
            </button>
          </div>
        </div>

        {tab === "details" ? (
          <div role="tabpanel" className="mt-5 flex flex-col gap-5">
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

            <SoulField
              bot={bot}
              onPatch={patch}
              simple={{
                label: t("botSettings.simple.instructions"),
                placeholder: t("botSettings.simple.instructionsPlaceholder", { name: bot.name }),
              }}
            />

            {/* The bot's model, in the same plain-words picker as the chat
                header, shown in place (a floating popover would be clipped by
                this scrolling panel). A pick is the bot's model: groups and
                every thread without its own model move with it, like the full
                Model section, and the line below counts the threads that don't. */}
            <div data-simple-default-model>
              <ModelPicker
                bot={bot}
                contained
                label={<span className="text-[12px] text-ink-secondary">{t("botSettings.simple.defaultModel")}</span>}
              />
              <ThreadModelsLine bot={bot} className="mt-2" />
            </div>

            <div>
              <div className={labelCls}>{t("botSettings.simple.beforeActs", { name: bot.name })}</div>
              <div className="grid grid-cols-2 gap-3">
                {([
                  { mode: "ask", title: t("botSettings.simple.ask"), hint: t("botSettings.simple.askHint"), offered: true },
                  { mode: "auto", title: t("botSettings.simple.decide"), hint: t("botSettings.simple.decideHint"), offered: autoOffered },
                ] as const).map((choice) => {
                  const selected = displayedApprovalMode === choice.mode;
                  return (
                    <button
                      key={choice.mode}
                      type="button"
                      data-approval-choice={choice.mode}
                      aria-pressed={selected}
                      disabled={Boolean(bot.busy) || !choice.offered}
                      onClick={() => chooseMode(choice.mode)}
                      className={cn(
                        "flex min-w-0 flex-col items-start gap-0.5 rounded-xl border px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                        selected ? "border-accent-border bg-raised-hover" : "border-hairline/40 bg-inset enabled:hover:bg-raised",
                      )}
                    >
                      <span className="text-[14px] font-medium text-ink">{choice.title}</span>
                      <span className="text-[12px] text-ink-secondary">{choice.hint}</span>
                    </button>
                  );
                })}
              </div>
              {customMode && (
                <div className="mt-2 text-[12px] text-ink-secondary" data-approval-custom>
                  {t("botSettings.simple.customMode")}
                </div>
              )}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-secondary">{t("botSettings.simple.skills")}</span>
                <button
                  type="button"
                  data-simple-add-skill
                  onClick={onAddSkill}
                  className="rounded-md px-1.5 py-0.5 text-[12px] font-medium text-accent-text hover:bg-raised"
                >
                  {t("botSettings.simple.addSkill")}
                </button>
              </div>
              {!skills.loading && skills.skills.length === 0 ? (
                <div className="text-[12.5px] text-ink-tertiary">{t("botSettings.simple.noSkills")}</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {skills.skills.map((skill) => (
                    <div key={skill.name} className="flex items-center gap-3 rounded-xl border border-hairline/40 bg-inset px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium text-ink">{skill.name}</div>
                        <div className="truncate text-[12px] text-ink-secondary">{skill.description || skill.source}</div>
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
            </div>

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
        ) : (
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
          dispatch({ type: "updateBot", botId: target, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
        }}
      />
    </>
  );
}
