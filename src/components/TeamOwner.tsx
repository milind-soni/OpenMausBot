// "Reports to" on a Team Cloud: the face of the person a bot reports to at the end of its sidebar row, the picker that
// changes it (for an Admin, or the person it reports to now), and this person's Needs you.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, openThread, type Bot } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { askingWhom, mayChangeOwner, ownerChanged, ownerOf, useTeamPeople, type TeamPeople, type TeamPerson } from "@/state/team-people";
import { useHeldMenuMotion } from "./MenuMotion";

export type OwnerPickerTarget = { botIds: string[]; title: string; current: string | null; x: number; y: number };

const hosts: Array<(target: OwnerPickerTarget) => void> = [];
/** Opens the picker of the host mounted last, from a bot row, a bot's menu, a department's or the Team map. */
export function requestOwnerPick(target: OwnerPickerTarget): void {
  hosts.at(-1)?.(target);
}

export function OwnerPickerHost() {
  const [target, setTarget] = useState<OwnerPickerTarget | null>(null);
  useEffect(() => {
    hosts.push(setTarget);
    return () => { hosts.splice(hosts.lastIndexOf(setTarget), 1); };
  }, []);
  const close = useCallback(() => setTarget(null), []);
  return <OwnerPicker target={target} onClose={close} />;
}

const initial = (person: TeamPerson) => person.name.trim().charAt(0).toUpperCase() || "?";
const HUES = ["bg-[#5B8DEF]", "bg-[#E0745B]", "bg-[#4FAF7F]", "bg-[#B26BD9]", "bg-[#D9A23B]", "bg-[#3BA7B8]"];
const hueOf = (email: string) => HUES[[...email].reduce((sum, char) => sum + char.charCodeAt(0), 0) % HUES.length];

export function PersonFace({ person, size = 18 }: { person: TeamPerson; size?: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
    className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white", hueOf(person.email))}>{initial(person)}</span>;
}

/** The bot's owner at the end of its row. Clicking it opens the picker when this person may change it. */
export function OwnerFace({ bot }: { bot: Bot }) {
  const team = useTeamPeople();
  if (!team) return null;
  const owner = ownerOf(bot, team);
  const label = owner ? t("owner.tooltip", { name: owner.name }) : t("owner.tooltipNone");
  const face = owner ? <PersonFace person={owner} /> : <span aria-hidden="true" className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-dashed border-ink-secondary/60 text-[10px] text-ink-secondary">?</span>;
  if (!mayChangeOwner(bot, team)) return <span data-owner-face={owner?.email ?? ""} role="img" aria-label={label} title={label} className="flex shrink-0">{face}</span>;
  return <button type="button" data-owner-face={owner?.email ?? ""} aria-label={`${label}. ${t("owner.change", { bot: bot.name })}`} title={label}
    onClick={(event) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      requestOwnerPick({ botIds: [bot.id], title: t("owner.pickTitle"), current: owner?.email ?? null, x: rect.left, y: rect.bottom + 4 });
    }}
    className="flex shrink-0 rounded-full outline-none hover:ring-2 hover:ring-accent/40 focus-visible:ring-2 focus-visible:ring-accent/60">{face}</button>;
}

/** Changes who one bot, or every bot of a department, reports to. */
export function OwnerPicker({ target, onClose }: { target: OwnerPickerTarget | null; onClose: () => void }) {
  const { dispatch } = useStore();
  const team = useTeamPeople();
  const motion = useHeldMenuMotion(target);
  const shown = motion.value;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!target) return;
    const onDown = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest("[data-owner-picker]")) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [target, onClose]);
  if (!motion.shown || !shown || !team) return null;
  const pick = async (person: TeamPerson) => {
    setBusy(true);
    try {
      if (shown.botIds.length === 1) {
        const answer = await api<{ bot?: Bot }>(`/api/bots/${shown.botIds[0]}/reports-to`, { method: "PUT", body: JSON.stringify({ email: person.email }) });
        if (answer?.bot) dispatch({ type: "botPatched", bot: answer.bot });
      } else {
        const answer = await api<{ bots?: Bot[] }>("/api/team/reports-to", { method: "PUT", body: JSON.stringify({ botIds: shown.botIds, email: person.email }) });
        for (const bot of answer?.bots ?? []) dispatch({ type: "botPatched", bot });
      }
      ownerChanged();
      onClose();
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  const top = Math.max(8, Math.min(shown.y, window.innerHeight - 320));
  const left = Math.max(8, Math.min(shown.x, window.innerWidth - 260));
  return createPortal(
    <div data-owner-picker role="menu" aria-label={shown.title} style={{ top, left }}
      className={cn("fixed z-50 w-[248px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-2 shadow-2xl shadow-black/60", motion.className)} {...motion.exitProps}>
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">{shown.title}</div>
      <div className="flex max-h-[260px] flex-col gap-0.5 overflow-y-auto px-1.5 py-1">
        {team.people.map((person) => (
          <button key={person.email} type="button" role="menuitemradio" aria-checked={person.email === shown.current} disabled={busy}
            onClick={() => void pick(person)}
            className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink", person.email === shown.current ? "bg-raised" : "hover:bg-raised/70")}>
            <PersonFace person={person} size={20} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{person.you ? t("owner.you", { name: person.name }) : person.name}</span>
              <span className="block truncate text-[11px] text-ink-secondary">{person.email}</span>
            </span>
            {person.email === shown.current && <Check size={14} className="shrink-0 text-accent" />}
          </button>
        ))}
      </div>
      <div className="px-3.5 pt-1 text-[11px] leading-snug text-ink-secondary">{t("owner.pickHint")}</div>
    </div>,
    document.body,
  );
}

/** The bot menu's line: "Reports to Bob…". */
export function ownerMenuLabel(bot: Bot, team: TeamPeople): string {
  const owner = ownerOf(bot, team);
  return owner ? t("owner.menu", { name: owner.name }) : t("owner.menuNone");
}

/** Opens the picker for one bot, or for every bot of a department ("Set owner for all bots…"). */
export function pickOwnerOf(bots: readonly Bot[], team: TeamPeople, at: { x: number; y: number; name?: string }): void {
  if (!bots.length) return;
  const title = bots.length === 1 && at.name === undefined ? t("owner.pickTitle") : t("owner.setForAllTitle", { name: at.name ?? "" });
  const current = bots.length === 1 ? ownerOf(bots[0]!, team)?.email ?? null : departmentOwner(bots, team)?.email ?? null;
  requestOwnerPick({ botIds: bots.map((bot) => bot.id), title, current, x: at.x, y: at.y });
}

/** The person every bot in a department reports to, when they all report to one person. */
export function departmentOwner(bots: readonly Bot[], team: ReturnType<typeof useTeamPeople>): TeamPerson | null {
  if (!team || bots.length === 0) return null;
  const owners = bots.map((bot) => ownerOf(bot, team));
  const first = owners[0];
  return first && owners.every((owner) => owner?.email === first.email) ? first : null;
}

/** On a Team Cloud: what the bots ask of this person, newest first, each one opening its conversation. */
export function NeedsYouButton({ compact = false }: { compact?: boolean }) {
  const team = useTeamPeople();
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest("[data-needs-you]")) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const items = team?.needsYou ?? [];
  if (!team || items.length === 0) return null;
  const label = t("needsYou.count", { count: items.length });
  const botName = (botId: string) => state.bots.find((bot) => bot.id === botId)?.name ?? t("needsYou.aBot");
  return (
    <div data-needs-you className={cn("relative", compact ? "px-1" : "px-2 pb-1")}>
      <button type="button" aria-expanded={open} aria-haspopup="menu" aria-label={label} title={label} onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-warning hover:bg-raised/60">
        <Bell size={15} aria-hidden="true" className="shrink-0" />
        {!compact && <span className="min-w-0 flex-1 truncate">{t("needsYou.title")}</span>}
        <span className="rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular-nums text-panel">{items.length}</span>
      </button>
      {open && (
        <div role="menu" aria-label={t("needsYou.title")} className="absolute left-2 right-2 top-full z-40 mt-1 max-h-[340px] overflow-y-auto rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60">
          {items.map((item) => {
            const botId = "botId" in item ? item.botId : item.botIds[0]!;
            const title = item.kind === "question" ? t("needsYou.asking", { bot: botName(botId) }) : t("needsYou.fix", { bot: botName(botId) });
            const text = "text" in item ? item.text : "";
            return <button key={`${item.kind}:${item.id}`} type="button" role="menuitem"
              onClick={() => { setOpen(false); if (item.threadId) openThread(dispatch, { botId, threadId: item.threadId }, state, showThreads); }}
              className="flex w-full flex-col items-start px-3.5 py-2 text-left hover:bg-raised/70">
              <span className="w-full truncate text-[13px] text-ink">{title}</span>
              {text && <span className="w-full truncate text-[11.5px] text-ink-secondary">{text}</span>}
            </button>;
          })}
        </div>
      )}
    </div>
  );
}

/** Above an open question or approval in a shared team chat: whose answer it waits for. */
export function AskingLine({ botId, threadId }: { botId: string; threadId: string }) {
  const team = useTeamPeople();
  const { state } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (!team || !bot) return null;
  const person = askingWhom(bot, bot.tasks?.find((task) => task.threadId === threadId), team);
  if (!person) return null;
  return <div data-asking={person.email} className="mb-1.5 flex items-center gap-1.5 text-[12px] text-ink-secondary">
    <PersonFace person={person} size={14} />{person.you ? t("owner.askingYou") : t("owner.asking", { name: person.name })}
  </div>;
}
