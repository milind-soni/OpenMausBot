// A team bot's owner on a Team Cloud: the picker that changes it (for an Admin, or its owner now), a teammate's face,
// and this person's Needs you.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, openThread, type Bot } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { askingWhom, ownerChanged, ownerOf, pictureOf, refreshNeedsYou, useTeamPeople, type TeamPeople, type TeamPerson } from "@/state/team-people";
import type { NeedsYouItem } from "../../shared/today";
import { useInboxSupport } from "@/state/inbox";
import { useHeldMenuMotion } from "./MenuMotion";
import { MENU_HEADING, MENU_SHEET } from "./menu-recipe";

export type OwnerPickerTarget = { botId: string; current: string | null; x: number; y: number };

const hosts: Array<(target: OwnerPickerTarget) => void> = [];
/** Opens the picker of the host mounted last, from a bot's menu. */
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

/** A teammate's picture, or their initial when they have none or it fails to load. */
export function PersonFace({ person, size = 18 }: { person: TeamPerson; size?: number }) {
  const picture = pictureOf(person, useTeamPeople());
  const [failed, setFailed] = useState<string | null>(null);
  if (picture && failed !== picture) {
    return <img src={picture} alt="" aria-hidden="true" draggable={false} data-person-picture={person.email} onError={() => setFailed(picture)}
      style={{ width: size, height: size }} className="inline-block shrink-0 rounded-full bg-raised object-cover" />;
  }
  return <span aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
    className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white", hueOf(person.email))}>{initial(person)}</span>;
}

/** Changes a bot's owner. */
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
      const answer = await api<{ bot?: Bot }>(`/api/bots/${shown.botId}/reports-to`, { method: "PUT", body: JSON.stringify({ email: person.email }) });
      if (answer?.bot) dispatch({ type: "botPatched", bot: answer.bot });
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
    <div data-owner-picker role="menu" aria-label={t("lookedAfter.owner")} style={{ top, left }}
      className={cn("fixed z-50 w-[248px] overflow-hidden", MENU_SHEET, motion.className)} {...motion.exitProps}>
      <div className={MENU_HEADING}>{t("lookedAfter.owner")}</div>
      <div className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
        {team.people.map((person) => (
          <button key={person.email} type="button" role="menuitemradio" aria-checked={person.email === shown.current} disabled={busy}
            onClick={() => void pick(person)}
            className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink", person.email === shown.current ? "bg-menu-active" : "hover:bg-menu-hover")}>
            <PersonFace person={person} size={20} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{person.you ? t("owner.you", { name: person.name }) : person.name}</span>
              <span className="block truncate text-[11px] text-ink-secondary">{person.email}</span>
            </span>
            {person.email === shown.current && <Check size={14} className="shrink-0 text-accent" />}
          </button>
        ))}
      </div>
      <div className="px-2 pb-1 text-[12px] leading-4 text-ink-tertiary">{t("lookedAfter.pickHint")}</div>
    </div>,
    document.body,
  );
}

/** The bot menu's line: "Owner: Bob…". */
export function ownerMenuLabel(bot: Bot, team: TeamPeople): string {
  const owner = ownerOf(bot, team);
  return owner ? t("lookedAfter.menu", { name: owner.name }) : t("lookedAfter.menuNone");
}

export function pickOwnerOf(bot: Bot, team: TeamPeople, at: { x: number; y: number }): void {
  requestOwnerPick({ botId: bot.id, current: ownerOf(bot, team)?.email ?? null, x: at.x, y: at.y });
}

/** A tag or passed message is done once its person opens it, even in a shared chat someone else already read. */
function readConversation(groups: ReadonlyArray<{ id: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string }> }>, botId: string, threadId: string) {
  const group = groups.find((one) => one.threadId === threadId || one.tasks?.some((task) => task.threadId === threadId));
  void (group ? api(`/api/groups/${group.id}/read`, { method: "POST" }) : api(`/api/bots/${botId}/read`, { method: "POST", body: JSON.stringify({ threadId }) }))
    .then(() => refreshNeedsYou()).catch(() => {});
}

/** A Needs you line's title, after the face of the teammate it is from. */
export function NeedsYouTitle({ item, title }: { item: NeedsYouItem; title: string }) {
  const from = item.kind === "message" && item.fromEmail ? { email: item.fromEmail, name: item.from, role: "member" } : null;
  if (!from) return <span className="w-full truncate text-[13px] text-ink">{title}</span>;
  return <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px] text-ink"><PersonFace person={from} size={16} /><span className="min-w-0 truncate">{title}</span></span>;
}

/** One thing that needs this person, opening its conversation. */
export function NeedsYouLine({ item, onOpened }: { item: NeedsYouItem; onOpened?: () => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const botName = (botId: string) => state.bots.find((bot) => bot.id === botId)?.name ?? t("needsYou.aBot");
  const botId = "botId" in item ? item.botId : item.botIds[0]!;
  const title = item.kind === "message" ? t("needsYou.message", { name: item.from })
    : item.kind === "question" ? t("needsYou.asking", { bot: botName(botId) }) : t("needsYou.fix", { bot: botName(botId) });
  const text = "text" in item ? item.text : "";
  return <button type="button" role="menuitem"
    onClick={() => {
      onOpened?.();
      if (!item.threadId) return;
      openThread(dispatch, { botId, threadId: item.threadId }, state, showThreads);
      if (item.kind === "message") readConversation(state.groups, botId, item.threadId);
    }}
    className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-menu-hover">
    <NeedsYouTitle item={item} title={title} />
    {text && <span className="w-full truncate text-[12px] text-ink-secondary">{text}</span>}
  </button>;
}

/** For a server older than this page, where the person has no inbox: what the bots ask of them, newest first. */
export function NeedsYouButton({ compact = false }: { compact?: boolean }) {
  const team = useTeamPeople();
  const support = useInboxSupport();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest("[data-needs-you]")) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const items = team?.needsYou ?? [];
  if (support !== "no" || !team || items.length === 0) return null;
  const label = t("needsYou.count", { count: items.length });
  return (
    <div data-needs-you className={cn("relative", compact ? "px-1" : "px-2 pb-1")}>
      <button type="button" aria-expanded={open} aria-haspopup="menu" aria-label={label} title={label} onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-warning hover:bg-raised/60">
        <Bell size={15} aria-hidden="true" className="shrink-0" />
        {!compact && <span className="min-w-0 flex-1 truncate">{t("needsYou.title")}</span>}
        <span className="rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular-nums text-panel">{items.length}</span>
      </button>
      {open && (
        <div role="menu" aria-label={t("needsYou.title")} className={cn("absolute left-2 right-2 top-full z-40 mt-1 max-h-[340px] overflow-y-auto", MENU_SHEET)}>
          {items.map((item) => <NeedsYouLine key={`${item.kind}:${item.id}`} item={item} onOpened={() => setOpen(false)} />)}
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
