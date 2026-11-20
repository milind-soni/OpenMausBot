import { MAUS_COLORS } from "@/lib/mascot";
import { Fragment, type CSSProperties } from "react";
import { mentionClassName, mentionRanges, type MentionPeer, type MentionPerson } from "@/lib/mentions";

import { BotAvatar, type BotAvatarProps } from "./Avatar";

export function BotMention({ bot, text, mirror = false }: { bot: BotAvatarProps["bot"] & { id?: string }; text: string; mirror?: boolean }) {
  const color = MAUS_COLORS[bot.color];
  return <span style={{ "--mention-color": color } as CSSProperties} className={mirror ? "bot-mention bot-mention-mirror" : "bot-mention"} data-bot-mention="" data-mention-bot-id={mirror ? bot.id : undefined}>
    <span className="bot-mention-icon" aria-hidden="true">
      {mirror && <span className="invisible">@</span>}
      <BotAvatar bot={bot} size={mirror ? 13 : 16} animated={false} />
    </span>{text.slice(1)}
  </span>;
}

export function MentionText({ text, peers, everyone = false, person, mirror = false }: {
  text: string; peers: readonly MentionPeer[]; everyone?: boolean; person?: MentionPerson; mirror?: boolean;
}) {
  let end = 0;
  const parts = mentionRanges(text, peers, everyone, person).map((range) => {
    const prefix = text.slice(end, range.start);
    end = range.end;
    const style = range.color ? { "--mention-color": range.color } as CSSProperties : undefined;
    const label = text.slice(range.start, range.end);
    return <Fragment key={range.start}>{prefix}{range.bot
      ? <BotMention bot={range.bot} text={label} mirror={mirror} />
      : <span className={mentionClassName(range)} style={style}>{label}</span>}</Fragment>;
  });
  return <>{parts}{text.slice(end)}</>;
}
