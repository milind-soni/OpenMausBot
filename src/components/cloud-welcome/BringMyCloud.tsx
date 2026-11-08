import { useEffect, useState } from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import { ipcErrorText, teamMoveLine } from "@/lib/cloud-send";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { TeamMoveView } from "../../../electron/team-move.mjs";
import { CARD, CARD_IDLE, CardIcon, SECONDARY } from "./parts";

const POLL_MS = 3_000;
type Bringable = { id: string; name: string; stays?: "default" | "chief" | "last" };

const WHY_IT_STAYS: Record<NonNullable<Bringable["stays"]>, LocaleKey> = {
  default: "cloudWelcome.bring.mausBotStays", chief: "teamMove.blockedChief", last: "teamMove.blockedLast",
};
const bridge = () => (typeof window !== "undefined" && !window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined);

/** On a team's own page in the desktop app: the person's bots on My Cloud, each moved here with one tap and main's own
 * confirm, which no page draws. Nothing shows for someone with none to bring. */
export function BringMyCloud() {
  const page = bridge();
  const [bots, setBots] = useState<Bringable[]>([]);
  const [move, setMove] = useState<TeamMoveView | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = () => {
    void page?.teamBring?.().then((answer) => { setBots(Array.isArray(answer?.bots) ? answer.bots : []); }).catch(() => {});
  };
  useEffect(read, []);
  const moving = move?.phase === "moving";
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => { void page?.teamBringStatus?.().then((next) => { setMove(next); if (next?.phase === "done") read(); }).catch(() => {}); }, POLL_MS);
    return () => clearInterval(timer);
  }, [moving]);
  if (!page?.teamBringMove || (!bots.some((bot) => !bot.stays) && !move)) return null;
  const ask = (bot: Bringable) => {
    setAsking(bot.id);
    setError(null);
    void page.teamBringMove!(bot.id)
      .then((answer) => { if (answer.started) setMove(answer.move); })
      .catch((cause: unknown) => setError(ipcErrorText(cause) ?? t("cloudWelcome.bring.moveFailed", { bot: bot.name })))
      .finally(() => setAsking(null));
  };
  const line = move && teamMoveLine(move);
  return <div data-bring-my-cloud className={cn(CARD, CARD_IDLE)}>
    <CardIcon icon={ArrowRightLeft} />
    <span className="text-[15px] font-semibold text-ink">{t("cloudWelcome.bring.myCloudTitle")}</span>
    <span className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudWelcome.bring.myCloudHint")}</span>
    <ul className="mt-1 flex flex-col gap-1">
      {bots.map((bot) => <li key={bot.id} data-bring-bot={bot.id} className="flex min-w-0 items-center gap-3">
        <span dir="auto" className={cn("min-w-0 truncate text-[14px] text-ink", bot.stays ? "max-w-[50%] shrink-0" : "flex-1")}>{bot.name}</span>
        {bot.stays
          ? <span className="min-w-0 flex-1 text-end text-[12px] text-ink-tertiary">{t(WHY_IT_STAYS[bot.stays])}</span>
          : <button type="button" data-bring-move={bot.id} className={SECONDARY} disabled={asking !== null || moving} onClick={() => ask(bot)}>{t("cloudWelcome.bring.move")}</button>}
      </li>)}
    </ul>
    {line && <span role="status" data-bring-line={line.kind} className="inline-flex items-center gap-2 text-[13px] text-ink-secondary">
      {line.kind === "sending" && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}<span dir="auto">{line.text}</span>
    </span>}
    {error && <span role="alert" className="text-[13px] text-danger">{error}</span>}
  </div>;
}
