// Soul: the bot's standing instructions (SOUL.md), plus a short intro so a
// bot's Read all link into this section always lands somewhere legible.
import type { Bot } from "@/state/store";
import { SoulField } from "../SoulField";
import type { BotPatch } from "./useBotSettingsDerived";

export function SoulSection({ bot, patch }: { bot: Bot; patch: (patch: BotPatch) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        Who this bot is and the rules it never breaks. Always in its context.
      </p>
      <SoulField bot={bot} onPatch={patch} />
    </div>
  );
}
