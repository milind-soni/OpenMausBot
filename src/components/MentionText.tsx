import { Fragment, type CSSProperties } from "react";
import { mentionClassName, mentionRanges, type MentionPeer, type MentionPerson } from "@/lib/mentions";

export function MentionText({ text, peers, everyone = false, person }: {
  text: string; peers: readonly MentionPeer[]; everyone?: boolean; person?: MentionPerson;
}) {
  let end = 0;
  const parts = mentionRanges(text, peers, everyone, person).map((range) => {
    const prefix = text.slice(end, range.start);
    end = range.end;
    const style = range.color ? { "--mention-color": range.color } as CSSProperties : undefined;
    return <Fragment key={range.start}>{prefix}<span className={mentionClassName(range)} style={style}>{text.slice(range.start, range.end)}</span></Fragment>;
  });
  return <>{parts}{text.slice(end)}</>;
}
