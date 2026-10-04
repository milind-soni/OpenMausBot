// Model: which provider/model this bot runs on, and how hard it thinks.
// Moved from SettingsPanel.tsx (~835-881). ModelPicker keeps `contained`:
// this section sits inside the dialog's overflow-y-auto scroller, where the
// picker's floating popover (absolute, ~480px tall) would open below the
// fold and only become visible by scrolling; the in-flow menu pushes the
// Effort card down instead and is fully visible where it opens.
import { EffortRow, ModelPicker } from "../ModelPicker";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { useBotEditor } from "./BotEditorContext";
import { ProposalStatus } from "./ProposalStatus";

export function ModelSection({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { draft } = useBotEditor();
  const modelVariants = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.modelVariants;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <ModelPicker
          bot={bot}
          contained
          label={
            <div>
              <div className="text-[15px] font-medium text-ink">{t("modelSection.defaultModel")}</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {draft ? t("modelSection.startingModel") : t("modelSection.forGroupsNewThreads")}
              </div>
              <ProposalStatus bot={bot} kind="chief" />
            </div>
          }
        />
      </div>

      {/* Share the model picker's effort choices, but edit the profile default. */}
      <EffortRow
        bot={bot}
        className="rounded-xl bg-card p-4"
        label={
          <div>
            <div className="text-[15px] font-medium text-ink">{modelVariants ? t("modelSection.reasoning") : t("modelSection.effort")}</div>
            {/* Says what the app does, not what the engine ends up at:
                Codex applies a level to the whole thread and has no way to
                take one back, so "currently: engine default" was a promise
                we could not keep for a thread that had already been sent
                one. Sending nothing is true on every engine. */}
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {modelVariants ? (draft ? t("modelSection.startingVariant") : t("modelSection.groupsNewThreadsVariant")) : t("modelSection.howHard") + (bot.modelSelection.effort ? "" : t("modelSection.howHardDefault"))}
            </div>
            <ProposalStatus bot={bot} kind="chief" />
          </div>
        }
      />
      {!draft && <FallbackChain bot={bot} onChange={(fallback) => dispatch({ type: "updateBot", botId: bot.id, patch: { fallback } })} />}
    </div>
  );
}

/** Ordered backups use the same opt-in, proven-before-start recovery as
 * the workspace backup. They change only the failed thread's model. */
function FallbackChain({ bot, onChange }: { bot: Bot; onChange: (fallback: Bot["fallback"]) => void }) {
  const { state } = useStore();
  const chain = bot.fallback ?? [];
  const available = state.instances.filter(
    (instance) =>
      instance.snapshot.state === "available" &&
      Boolean(instance.models.default.trim()) &&
      instance.instanceId !== bot.modelSelection.instanceId &&
      !chain.some((entry) => entry.instanceId === instance.instanceId),
  );
  const nameOf = (instanceId: string) => state.instances.find((instance) => instance.instanceId === instanceId)?.displayName ?? instanceId;

  const add = (instanceId: string) => {
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance || !instance.models.default.trim() || chain.length >= 5 || !available.includes(instance)) return;
    onChange([...chain, { instanceId, model: instance.models.default }]);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("modelSection.backupModels")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {t("modelSection.backupModelsHint")}
      </div>
      {!state.config?.automaticRecovery?.enabled && <p className="mt-2 text-[12px] text-ink-secondary">{t("modelSection.recoveryOff")}</p>}
      {chain.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1">
          {chain.map((entry, index) => (
            <li key={entry.instanceId} className="flex items-center gap-2 rounded-lg bg-inset px-3 py-1.5 text-[13px]">
              <span className="w-4 shrink-0 tabular-nums text-ink-secondary">{index + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-ink">{nameOf(entry.instanceId)}</span>
              <span className="shrink-0 truncate text-[11.5px] text-ink-secondary">{entry.model}</span>
              <button
                type="button"
                onClick={() => onChange(chain.filter((candidate) => candidate.instanceId !== entry.instanceId))}
                aria-label={t("modelSection.removeFallback", { name: nameOf(entry.instanceId) })}
                className="shrink-0 rounded p-0.5 text-ink-secondary hover:text-ink"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}
      {chain.length < 5 && (
        <div className={cn("flex items-center gap-2", chain.length > 0 ? "mt-2" : "mt-3")}>
          <select
            value=""
            onChange={(event) => add(event.target.value)}
            aria-label={t("modelSection.addFallbackLabel")}
            disabled={available.length === 0}
            className="rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[13px] text-ink disabled:opacity-50"
          >
            <option value="">{available.length === 0 ? t("modelSection.noOtherEngine") : t("modelSection.addEngine")}</option>
            {available.map((instance) => (
              <option key={instance.instanceId} value={instance.instanceId}>
                {instance.displayName}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
