import { Fragment } from "react";

import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { MAUS_COLOR_NAMES, normalizeState, type MausColor } from "@/lib/mascot";
import type { RoomAddressee } from "@/lib/room-addressees";
import type { Bot } from "@/state/store";

function isPaletteColor(color: string | undefined): color is MausColor {
  return (MAUS_COLOR_NAMES as readonly string[]).includes(color ?? "");
}

function Name({ name, color }: { name: string; color?: string }) {
  const known = isPaletteColor(color);
  return (
    <span
      className={cn("text-[13px] font-semibold", known ? "bot-identity" : "text-ink-secondary")}
      data-bot-color={known ? color : undefined}
    >{name}</span>
  );
}

export function ClusterLabel({ bot, name, color, to = [] }: { bot?: Bot; name: string; color: string; to?: readonly RoomAddressee[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-0.5">
      <BotAvatar
        bot={bot ?? { name, color: color as Bot["color"] }}
        state={normalizeState(bot?.mascotExpression) ?? "happy"}
        size={20}
        motion="none"
        motionKey={0}
        animated={false}
        readable={isPaletteColor(color)}
      />
      <Name name={name} color={color} />
      {to.length > 0 && (
        <>
          <span className="inline-block text-[13px] text-ink-tertiary rtl:-scale-x-100">→</span>
          {to.map((addressee, index) => (
            <Fragment key={addressee.key}>
              <Name name={addressee.name} color={addressee.color} />
              {index < to.length - 1 && <span className="-ms-1 text-[13px] text-ink-tertiary">,</span>}
            </Fragment>
          ))}
        </>
      )}
    </div>
  );
}
