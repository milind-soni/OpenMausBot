import { useEffect, useState } from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import type { TeamBringable } from "../../../electron/cloud-send.mjs";
import type { TeamMoveSource, TeamMoveView } from "../../../electron/team-move.mjs";
import { ipcErrorText, teamMoveLine } from "@/lib/cloud-send";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { MoveChooser } from "../MoveToMyCloud";
import { CARD, CARD_IDLE, CardIcon, SECONDARY } from "./parts";

const POLL_MS = 3_000;

const WHY_IT_STAYS: Record<TeamMoveSource, Record<NonNullable<TeamBringable["stays"]>, LocaleKey>> = {
  cloud: { default: "cloudWelcome.bring.mausBotStays", chief: "teamMove.blockedChief", last: "teamMove.blockedLast" },
  computer: { default: "teamMove.mausBotStaysComputer", chief: "teamMove.blockedChiefComputer", last: "teamMove.blockedLastComputer" },
};
const bridge = () => (typeof window !== "undefined" && !window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined);

/** On a team's own page in the desktop app: the person's bots on My Cloud and on this computer, each moved here with one
 * tap and main's own confirm, which no page draws; several of this computer's at once through the chooser, with one such
 * confirm. Nothing shows for someone with none to bring. */
export function BringMyCloud() {
  const page = bridge();
  const [bots, setBots] = useState<TeamBringable[]>([]);
  const [computer, setComputer] = useState<TeamBringable[]>([]);
  const [team, setTeam] = useState<string | null>(null);
  const [move, setMove] = useState<TeamMoveView | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = () => {
    void page?.teamBring?.().then((answer) => {
      setBots(Array.isArray(answer?.bots) ? answer.bots : []);
      setComputer(Array.isArray(answer?.computer) ? answer.computer : []);
      setTeam(answer?.team?.name ?? null);
    }).catch(() => {});
  };
  useEffect(read, []);
  const moving = move?.phase === "moving";
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => { void page?.teamBringStatus?.().then((next) => { setMove(next); if (next?.phase !== "moving") read(); }).catch(() => {}); }, POLL_MS);
    return () => clearInterval(timer);
  }, [moving]);
  const fromCloud = bots.some((bot) => !bot.stays), fromComputer = computer.some((bot) => !bot.stays);
  if (!page?.teamBringMove || (!fromCloud && !fromComputer && !move)) return null;
  const ask = (bot: TeamBringable, from: TeamMoveSource) => {
    setAsking(bot.id);
    setError(null);
    void (from === "computer" ? page.teamBringMove!(bot.id, from) : page.teamBringMove!(bot.id))
      .then((answer) => { if (answer.started) setMove(answer.move); })
      .catch((cause: unknown) => setError(ipcErrorText(cause) ?? t(from === "computer" ? "cloudWelcome.bring.computerFailed" : "cloudWelcome.bring.moveFailed", { bot: bot.name })))
      .finally(() => setAsking(null));
  };
  const several = async (ids: string[]) => {
    const answer = await page.teamBringMany!(ids);
    if (answer.started) setMove(answer.move);
  };
  const line = move && teamMoveLine(move);
  const list = (from: TeamMoveSource, entries: TeamBringable[]) => <ul className="mt-1 flex flex-col gap-1" data-bring-from={from}>
    {entries.map((bot) => <li key={bot.id} data-bring-bot={from === "computer" ? undefined : bot.id} data-bring-computer-bot={from === "computer" ? bot.id : undefined} className="flex min-w-0 items-center gap-3">
      <span dir="auto" className={cn("min-w-0 truncate text-[14px] text-ink", bot.stays ? "max-w-[50%] shrink-0" : "flex-1")}>{bot.name}</span>
      {bot.stays
        ? <span className="min-w-0 flex-1 text-right text-[12px] text-ink-tertiary">{t(WHY_IT_STAYS[from][bot.stays])}</span>
        : <button type="button" {...(from === "computer" ? { "data-bring-move-computer": bot.id } : { "data-bring-move": bot.id })} className={SECONDARY}
          disabled={asking !== null || moving} onClick={() => ask(bot, from)}>{t("cloudWelcome.bring.move")}</button>}
    </li>)}
  </ul>;
  return <div data-bring-my-cloud className={cn(CARD, CARD_IDLE)}>
    <CardIcon icon={ArrowRightLeft} />
    {fromCloud && <>
      <span className="text-[15px] font-semibold text-ink">{t("cloudWelcome.bring.myCloudTitle")}</span>
      <span className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudWelcome.bring.myCloudHint")}</span>
      {list("cloud", bots)}
    </>}
    {fromComputer && <>
      <span data-bring-computer className={cn("text-[15px] font-semibold text-ink", fromCloud && "mt-2")}>{t("cloudWelcome.bring.computerTitle")}</span>
      {!fromCloud && <span className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudWelcome.bring.myCloudHint")}</span>}
      {list("computer", computer)}
      {page.teamBringMany && computer.filter((bot) => !bot.stays).length > 1 && <button type="button" data-bring-several className="self-start text-[13px] font-medium text-accent-text underline underline-offset-2 hover:text-ink"
        disabled={asking !== null || moving} onClick={() => setChoosing(true)}>{t("cloudWelcome.bring.several")}</button>}
    </>}
    {line && <span role="status" data-bring-line={line.kind} className="inline-flex items-center gap-2 text-[13px] text-ink-secondary">
      {line.kind === "sending" && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}<span dir="auto">{line.text}</span>
    </span>}
    {error && <span role="alert" className="text-[13px] text-danger">{error}</span>}
    {choosing && <MoveChooser onClose={() => setChoosing(false)} team={{ name: team ?? move?.team.name ?? "", bots: computer, move: several }} />}
  </div>;
}
