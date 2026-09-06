// Model: which provider/model this bot runs on, and how hard it thinks.
// Moved from SettingsPanel.tsx (~835-881). ModelPicker keeps `contained`:
// this section sits inside the dialog's overflow-y-auto scroller, where the
// picker's floating popover (absolute, ~480px tall) would open below the
// fold and only become visible by scrolling; the in-flow menu pushes the
// Effort card down instead and is fully visible where it opens.
import { ModelPicker } from "../ModelPicker";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
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
