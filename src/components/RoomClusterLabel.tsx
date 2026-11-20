import { Fragment, memo } from "react";

import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { sameDrawnBots } from "@/lib/drawn-bots";
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

interface ClusterLabelProps {
  bot?: Bot;
  name: string;
  color: string;
  to?: readonly RoomAddressee[];
  /** Drawn again in a new language. */
  locale?: string;
}

const sameAddressees = (a: readonly RoomAddressee[] = [], b: readonly RoomAddressee[] = []) =>
  a.length === b.length && a.every((one, i) => one.key === b[i]!.key && one.name === b[i]!.name && one.color === b[i]!.color);

/** Drawn again only when what it shows changes: a bot's status, words or turn leave it as it is. */
function sameLabel(a: ClusterLabelProps, b: ClusterLabelProps): boolean {
  return a.name === b.name && a.color === b.color && a.locale === b.locale && sameAddressees(a.to, b.to)
    && (a.bot === b.bot || (a.bot !== undefined && b.bot !== undefined && sameDrawnBots([a.bot], [b.bot])));
}

export const ClusterLabel = memo(function ClusterLabel({ bot, name, color, to = [] }: ClusterLabelProps) {
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
}, sameLabel);
