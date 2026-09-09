// Model: which provider/model this bot runs on, and how hard it thinks.
// Moved from SettingsPanel.tsx (~835-881). ModelPicker keeps `contained`:
// this section sits inside the dialog's overflow-y-auto scroller, where the
// picker's floating popover (absolute, ~480px tall) would open below the
// fold and only become visible by scrolling; the in-flow menu pushes the
// Effort card down instead and is fully visible where it opens.
import { EffortRow, ModelPicker } from "../ModelPicker";
import type { Bot } from "@/state/store";

export function ModelSection({ bot }: { bot: Bot }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <ModelPicker
          bot={bot}
          contained
          label={
            <div>
              <div className="text-[15px] font-medium text-ink">Default model</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                For new threads. Existing threads keep their own model choices.
              </div>
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
            <div className="text-[15px] font-medium text-ink">Effort</div>
            {/* Says what the app does, not what the engine ends up at:
                Codex applies a level to the whole thread and has no way to
                take one back, so "currently: engine default" was a promise
                we could not keep for a thread that had already been sent
                one. Sending nothing is true on every engine. */}
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              How hard new threads think{bot.modelSelection.effort ? "" : " (Default: no level is sent)"}
            </div>
          </div>
        }
      />
    </div>
  );
}
