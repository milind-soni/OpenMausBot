// "Move to Acme" on My Cloud or this computer, in the desktop app only: one item per team in a bot's menu, one confirm
// that names what goes and what stays (on this computer, with the way to choose several bots), the line that says how
// it goes (in CloudSendStrip), and the line a moved bot leaves in the sidebar, which opens it in the team. Main runs the
// move (electron/team-move-main.mjs); the teams come from the MausBot Cloud sign-in it verified, never from this page.
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRightLeft, Loader2, Users } from "lucide-react";
import type { TeamMoveSource, TeamMoveView } from "../../electron/team-move.mjs";
import type { Bot } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { MoveChooser } from "./MoveToMyCloud";
import { ipcErrorText, MY_CLOUD_TEAM, teamMoveLine, teamMoveRefusalText } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";

type Team = { id: string; name: string; ready: boolean };
type MenuItem = (icon: ReactNode, label: string, onClick?: () => void, opts?: { disabled?: boolean; hint?: string }) => ReactNode;

const bridge = () => (!window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined);

/** The teams a bot of this place can move into, and which place that is; none anywhere but My Cloud's own page and this
 * computer's in the app. */
export function useMoveTeams(): { teams: Team[]; from: TeamMoveSource } {
  const [teams, setTeams] = useState<{ teams: Team[]; from: TeamMoveSource }>({ teams: [], from: "cloud" });
  useEffect(() => {
    const page = bridge();
    if (!page?.teams) return;
    let alive = true;
    const read = () => void page.teams!().then((answer) => { if (alive) setTeams({ teams: Array.isArray(answer?.teams) ? answer.teams : [], from: answer?.from === "computer" ? "computer" : "cloud" }); })
      .catch(() => { if (alive) setTeams({ teams: [], from: "cloud" }); });
    read();
    window.addEventListener("focus", read);
    return () => { alive = false; window.removeEventListener("focus", read); };
  }, []);
  return teams;
}

/** The bot menu's "Move to {team}" items, and the one confirm they open. `blocked`: why this bot stays in the place
 * `from` is. */
export function useMoveToTeam({ blocked }: { blocked: (bot: Bot, from: TeamMoveSource) => string | undefined }) {
  const { teams, from } = useMoveTeams();
  const computer = from === "computer";
  const [asked, setAsked] = useState<{ bot: Bot; team: Team } | null>(null);
  const [several, setSeveral] = useState<{ bot: Bot; team: Team } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    const page = bridge();
    if (!asked || !page?.moveToTeam) return;
    setSending(true);
    setError(null);
    const { bot, team } = asked;
    const refused = page.moveToTeamCoded
      ? page.moveToTeamCoded(bot.id, team.id, bot.name).then((answer) => ("refused" in answer ? teamMoveRefusalText(answer.refused) : null))
      : page.moveToTeam(bot.id, team.id, bot.name).then(() => null);
    void refused
      .then((text) => (text ? setError(text) : setAsked(null)))
      .catch((cause: unknown) => setError(ipcErrorText(cause) ?? t("teamMove.failed", { bot: bot.name, team: team.name })))
      .finally(() => setSending(false));
  };
  const names = asked ? { bot: asked.bot.name, team: asked.team.name } : { bot: "", team: "" };
  const moveMany = (team: Team) => async (ids: string[]) => {
    const answer = await bridge()?.moveToTeamMany?.(ids, team.id);
    if (answer && "refused" in answer) throw new Error(teamMoveRefusalText(answer.refused));
  };
  return {
    items(bot: Bot, item: MenuItem): ReactNode[] {
      if (bot.movedTo || !teams.length) return [];
      const hint = blocked(bot, from);
      return teams.map((team) => item(<ArrowRightLeft size={16} className="text-ink-secondary" />, t("teamMove.menu", { team: team.name }),
        () => { setError(null); setAsked({ bot, team }); }, { disabled: Boolean(hint) || !team.ready, hint }));
    },
    // "Move several bots…" swaps the confirm for the chooser, with this bot ticked.
    dialog: several ? <MoveChooser onClose={() => setSeveral(null)} team={{ name: several.team.name, chosen: [several.bot.id], move: moveMany(several.team) }} /> : <ConfirmDialog
      open={asked !== null}
      tone="neutral"
      icon={<Users size={18} />}
      title={t("teamMove.title", names)}
      body={<span className="flex flex-col gap-2" data-team-move-confirm>
        <span>{t("teamMove.yours", names)}</span>
        <span>{t("teamMove.goes", names)}</span>
        <span>{t("teamMove.private", names)}</span>
        <span>{t(computer ? "teamMove.staysOnComputer" : "teamMove.staysOnMyCloud", names)}</span>
        {!computer && <span>{t("teamMove.dataStays", names)}</span>}
        <span data-team-move-final className="font-medium text-ink">{t(computer ? "teamMove.noWayBackComputer" : "teamMove.noWayBack", names)}</span>
        {computer && bridge()?.moveToTeamMany && <button type="button" data-team-move-several className="self-start font-medium text-accent-text underline underline-offset-2 hover:text-ink"
          disabled={sending} onClick={() => { setSeveral(asked); setAsked(null); }}>{t("teamMove.several")}</button>}
        {error && <span role="alert" className="text-danger">{error}</span>}
      </span>}
      confirmLabel={t("teamMove.confirm", names)}
      pending={sending}
      onCancel={() => setAsked(null)}
      onConfirm={confirm}
    />,
  };
}

/** What a bot moved into a team leaves on My Cloud: one line that opens it there. */
export function MovedBotRows({ bots }: { bots: readonly Bot[] }) {
  const moved = bots.filter((bot) => bot.movedTo?.state === "moved" && bot.movedTo.team.id !== MY_CLOUD_TEAM);
  if (!moved.length) return null;
  const page = bridge();
  return <div className="flex flex-col px-2 pb-1" data-moved-bots>
    {moved.map((bot) => <button key={bot.id} type="button" data-moved-bot={bot.id} disabled={!page?.openTeam}
      onClick={() => { void page?.openTeam?.(bot.movedTo!.team.id).catch(() => {}); }}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-secondary enabled:hover:bg-menu-hover enabled:hover:text-ink">
      <ArrowRightLeft size={14} aria-hidden="true" className="shrink-0" />
      <span className="truncate" dir="auto">{t("teamMove.pointer", { bot: bot.name, team: bot.movedTo!.team.name })}</span>
    </button>)}
  </div>;
}

/** The move's line, in the strip My Cloud's page shows: on its way, failed (Try again), or done (Open it there). */
export function TeamMoveLine({ move, onChange }: { move: TeamMoveView; onChange(next: TeamMoveView | null): void }) {
  const page = bridge();
  const [busy, setBusy] = useState(false);
  const line = teamMoveLine(move);
  const names = { bot: move.bot.name, team: move.team.name };
  const retry = () => {
    if (!page?.teamRetry) return;
    setBusy(true);
    void page.teamRetry().then(onChange).catch(() => {}).finally(() => setBusy(false));
  };
  const close = () => { void page?.dismiss("team-move").then(() => onChange(null)).catch(() => {}); };
  const link = "font-medium text-accent-text underline underline-offset-2 hover:text-ink";
  return <div role="status" data-cloud-send-strip={line.kind} data-team-move-line={move.phase} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
    {line.kind === "sending" || busy ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <ArrowRightLeft size={14} aria-hidden="true" />}
    <span dir="auto" data-cloud-send-strip-line>{line.text}</span>
    {line.kind === "done" && page?.openTeam && <>
      <button type="button" data-team-move-open className={link} onClick={() => { void page.openTeam!(move.team.id).catch(() => {}); }}>{move.batch && move.batch.length > 1 ? t("teamMove.openTeam", names) : t("teamMove.open", names)}</button>
      <span aria-hidden="true">·</span>
    </>}
    {line.kind === "failed" && !busy && <>
      <button type="button" data-team-move-retry className={link} onClick={retry}>{t("cloudSend.strip.retry")}</button>
      <span aria-hidden="true">·</span>
    </>}
    {line.kind !== "sending" && <button type="button" className="hover:text-ink" onClick={close}>{t("cloudSend.strip.close")}</button>}
  </div>;
}
