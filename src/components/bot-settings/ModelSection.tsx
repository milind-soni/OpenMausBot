// Model: which provider/model this bot runs on, and how hard it thinks.
// Moved from SettingsPanel.tsx (~835-881). ModelPicker keeps `contained`:
// this section sits inside the dialog's overflow-y-auto scroller, where the
// picker's floating popover (absolute, ~480px tall) would open below the
// fold and only become visible by scrolling; the in-flow menu pushes the
// Effort card down instead and is fully visible where it opens.
import { useState } from "react";
import { X } from "lucide-react";
import { ModelPicker } from "../ModelPicker";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

export function ModelSection({
  bot,
  derived,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
}) {
  const { patch, engine } = derived;

  return (
    <div className="flex flex-col gap-4">
      <FallbackChain bot={bot} onChange={(fallback) => patch({ fallback })} />
      <div className="rounded-xl bg-card p-4">
        <ModelPicker
          bot={bot}
          contained
          label={
            <div>
              <div className="text-[15px] font-medium text-ink">Model</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Which provider and model this bot runs on
              </div>
            </div>
          }
        />
      </div>

      {!!engine?.capabilities?.effortLevels?.length && (
        <div className="rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Effort</div>
          {/* Says what the app does, not what the engine ends up at:
              Codex applies a level to the whole thread and has no way to
              take one back, so "currently: engine default" was a promise
              we could not keep for a thread that had already been sent
              one. Sending nothing is true on every engine. */}
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            How hard this bot thinks{bot.modelSelection.effort ? "" : " (Default: no level is sent)"}
          </div>
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {([undefined, ...engine.capabilities.effortLevels] as const).map((level, i) => (
              <button
                key={level ?? "default"}
                aria-pressed={bot.modelSelection.effort === level}
                onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })}
                className={cn(
                  "flex-1 py-1.5 text-[13px] capitalize",
                  i > 0 && "border-l border-hairline/40",
                  bot.modelSelection.effort === level
                    ? "bg-control text-ink"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                )}
              >
                {/* the others capitalize cleanly; "xhigh" would read "Xhigh" */}
                {level === "xhigh" ? "X-High" : (level ?? "Default")}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Where a task carries on when this engine hits a usage limit, is rate
 * limited, or cannot be reached: the next engine here, in order. Another
 * account of the same engine (added under App Settings → Engines) or a
 * different engine; the transcript replays into whichever it lands on. */
function FallbackChain({ bot, onChange }: { bot: Bot; onChange: (fallback: Bot["fallback"]) => void }) {
  const { state } = useStore();
  const chain = bot.fallback ?? [];
  const available = state.instances.filter(
    (instance) =>
      instance.snapshot.state === "available" &&
      instance.instanceId !== bot.modelSelection.instanceId &&
      !chain.some((entry) => entry.instanceId === instance.instanceId),
  );
  const [adding, setAdding] = useState("");
  const nameOf = (instanceId: string) => state.instances.find((instance) => instance.instanceId === instanceId)?.displayName ?? instanceId;

  const add = (instanceId: string) => {
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance || chain.length >= 5) return;
    onChange([...chain, { instanceId, model: instance.models.default }]);
    setAdding("");
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">If this engine is unavailable</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        When the engine above hits its usage limit, is rate limited, or cannot be reached, the task carries on
        here, in order. Add a second account under App Settings → Engines to keep working on the same plan.
      </div>
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
                aria-label={`Remove ${nameOf(entry.instanceId)} from the fallback list`}
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
            value={adding}
            onChange={(event) => add(event.target.value)}
            aria-label="Add a fallback engine"
            disabled={available.length === 0}
            className="rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[13px] text-ink disabled:opacity-50"
          >
            <option value="">{available.length === 0 ? "No other engine is available" : "Add an engine…"}</option>
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
