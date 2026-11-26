import { approvalModeFor } from "../../shared/approval-mode";
import { personPin, type Place } from "@/lib/place";
import type { Bot, Task } from "@/state/store";
import { ApprovalChip, GoalToggle } from "./ComposerPlusMenu";
import { ModelPicker } from "./ModelPicker";
import { PhonePlus } from "./PhonePlus";
import { PlaceChip } from "./PlaceChip";
import type { ApprovalChoice } from "./thread-approval";

/**
 * The start of Advanced mode's footer under the field: one + holding every tool, the model, and a chip only for what
 * this conversation changes: Work until done while it is on, an approval level other than the bot's own, a pinned place.
 */
export function ComposerAdvancedTools({ profile, bot, task, locked, remoteClient, onAttach, goal, teach, approval, callBotId, onPin }: {
  profile?: Bot;
  /** The bot as this conversation runs it; undefined in a room. */
  bot?: Bot;
  task?: Pick<Task, "surface" | "surfaceAuto"> | null;
  locked: boolean;
  remoteClient: boolean;
  onAttach: () => void;
  goal?: { on: boolean; onToggle: () => void; solo?: boolean };
  teach?: () => void;
  approval?: ApprovalChoice;
  callBotId?: string;
  onPin: (surface: Place | null) => void;
}) {
  const place = bot && !remoteClient ? { bot, task, disabled: Boolean(bot.busy), onPin } : undefined;
  const ownLevel = approval && profile && bot && approvalModeFor(bot) !== approvalModeFor(profile);
  return (
    <div data-composer-tools className="flex min-w-0 flex-wrap items-center gap-1">
      {!locked && (
        <PhonePlus quiet onAttach={onAttach} goal={goal} teach={teach} callBotId={callBotId}
          approval={approval && bot && { name: bot.name, choice: approval }} place={place} />
      )}
      {bot && <ModelPicker key={bot.threadId} bot={bot} threadId={bot.threadId} quiet />}
      {!locked && goal?.on && <GoalToggle {...goal} />}
      {!locked && ownLevel && <ApprovalChip choice={approval} quiet />}
      {!locked && place && personPin(task) && <PlaceChip bot={place.bot} task={task} live={place.disabled} disabled={place.disabled} onPin={onPin} />}
    </div>
  );
}
