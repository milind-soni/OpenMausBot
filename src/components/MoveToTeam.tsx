// "Move to Acme" on My Cloud, in the desktop app only: one item per team in a bot's menu, one confirm that names what
// goes and what stays, the line that says how it goes (in CloudSendStrip), and the line a moved bot leaves in the
// sidebar, which opens it in the team. Main runs the move (electron/team-move-main.mjs); the teams come from the
// MausBot Cloud sign-in it verified, never from this page.
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRightLeft, Loader2, Users } from "lucide-react";
import type { TeamMoveView } from "../../electron/team-move.mjs";
import type { Bot } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { ipcErrorText, teamMoveLine } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";

type Team = { id: string; name: string; ready: boolean };
type MenuItem = (icon: ReactNode, label: string, onClick?: () => void, opts?: { disabled?: boolean; hint?: string }) => ReactNode;

const bridge = () => (!window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined);

/** The teams a bot of this Cloud can move into; none anywhere but My Cloud's own page in the app. */
export function useMoveTeams(): Team[] {
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => {
    const page = bridge();
    if (!page?.teams) return;
    let alive = true;
    const read = () => void page.teams!().then((answer) => { if (alive) setTeams(Array.isArray(answer?.teams) ? answer.teams : []); }).catch(() => { if (alive) setTeams([]); });
    read();
    window.addEventListener("focus", read);
    return () => { alive = false; window.removeEventListener("focus", read); };
  }, []);
  return teams;
}

/** The bot menu's "Move to {team}" items, and the one confirm they open. */
export function useMoveToTeam({ blocked }: { blocked: (bot: Bot) => string | undefined }) {
  const teams = useMoveTeams();
  const [asked, setAsked] = useState<{ bot: Bot; team: Team } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    const page = bridge();
    if (!asked || !page?.moveToTeam) return;
    setSending(true);
    setError(null);
    void page.moveToTeam(asked.bot.id, asked.team.id, asked.bot.name)
      .then(() => setAsked(null))
      .catch((cause: unknown) => setError(ipcErrorText(cause) ?? t("teamMove.failed", { bot: asked.bot.name, team: asked.team.name })))
      .finally(() => setSending(false));
  };
  const names = asked ? { bot: asked.bot.name, team: asked.team.name } : { bot: "", team: "" };
  return {
    items(bot: Bot, item: MenuItem): ReactNode[] {
      if (bot.movedTo || !teams.length) return [];
      const hint = blocked(bot);
      return teams.map((team) => item(<ArrowRightLeft size={16} className="text-ink-secondary" />, t("teamMove.menu", { team: team.name }),
        () => { setError(null); setAsked({ bot, team }); }, { disabled: Boolean(hint) || !team.ready, hint }));
    },
    dialog: <ConfirmDialog
      open={asked !== null}
      tone="neutral"
      icon={<Users size={18} />}
      title={t("teamMove.title", names)}
      body={<span className="flex flex-col gap-2" data-team-move-confirm>
        <span>{t("teamMove.everyone", names)}</span>
        <span>{t("teamMove.goes", names)}</span>
        <span>{t("teamMove.private", names)}</span>
        <span>{t("teamMove.stays", names)}</span>
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
  const moved = bots.filter((bot) => bot.movedTo?.state === "moved");
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
      <button type="button" data-team-move-open className={link} onClick={() => { void page.openTeam!(move.team.id).catch(() => {}); }}>{t("teamMove.open", names)}</button>
      <span aria-hidden="true">·</span>
    </>}
    {line.kind === "failed" && !busy && <>
      <button type="button" data-team-move-retry className={link} onClick={retry}>{t("cloudSend.strip.retry")}</button>
      <span aria-hidden="true">·</span>
    </>}
    {line.kind !== "sending" && <button type="button" className="hover:text-ink" onClick={close}>{t("cloudSend.strip.close")}</button>}
  </div>;
}
