import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Cloud, Gift, Megaphone, Rocket, UsersRound } from "lucide-react";
import type { CloudOffer } from "../../../electron/cloud-home.mjs";
import { itemSeen, rememberNoticeSeen, type HistoryAction, type HistoryItem, type HistoryMark, type HistoryModal } from "@/lib/announcement-history";
import { openEmailDraft, openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { reportTeams, teamsAction } from "@/lib/teams-whats-new";
import { reportWhatsNew, WHATS_NEW_SOURCES, whatsNewView, type WhatsNewView } from "@/lib/whats-new";
import { useStore } from "@/state/store";
import { localized, type AnnouncementAction, type AnnouncementPlace } from "../../../shared/announcements";
import { announcementPlaceAction, KIND_ICON, MARK } from "../AnnouncementCard";
import { GrokBotMark } from "../GrokBotMark";
import { GrokMovePopup } from "../GrokMovePopup";
import { GrokMoveDialog } from "../lazy-screens";
import { PRIMARY_BUTTON } from "../NoticeCard";
import { ModelgoMark, type IconProps } from "../ProviderIcons";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageHeader } from "../ToolPageShell";
import { TeamsPopup } from "../whats-new/TeamsPopup";
import { WhatsNewPopup } from "../whats-new/WhatsNewPopup";
import { useAnnouncements, type Announcements } from "./use-announcements";

const BUILT_IN_MARK: Record<HistoryMark, ComponentType<IconProps>> = {
  teams: UsersRound, cloud: Cloud, boat: Gift, modelgo: ModelgoMark, grok: GrokBotMark, "product-hunt": Rocket,
};
const QUIET_BUTTON = "ui-button min-h-9 gap-1.5 px-3 py-1.5";

/** A button that opens what an announcement's own notice opens, never anything else. */
export interface AnnouncementRun {
  url: (url: string) => void;
  email: (url: string) => void;
  place: (place: AnnouncementPlace) => void;
  cloudAdd: (action: Extract<HistoryAction, { cloud_add: unknown }>["cloud_add"]) => void;
  cloudHowTo: () => void;
}

function run(action: HistoryAction | AnnouncementAction, to: AnnouncementRun) {
  if ("open_url" in action) to.url(action.open_url);
  else if ("email" in action) to.email(action.email);
  else if ("open" in action) to.place(action.open);
  else if ("cloud_add" in action) to.cloudAdd(action.cloud_add);
  else to.cloudHowTo();
}

const dateText = (at: number, locale: string) => {
  try { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(at); } catch { return new Date(at).toISOString().slice(0, 10); }
};

function Mark({ item }: { item: HistoryItem }) {
  const Icon = item.source === "built-in" ? BUILT_IN_MARK[item.entry.mark] : item.card.image && "mark" in item.card.image ? MARK[item.card.image.mark] : KIND_ICON[item.card.kind];
  return <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.05] text-ink-secondary"><Icon size={18} /></span>;
}

/** One announcement: its date, mark, title and line or two, and its own buttons; a popup's row opens the popup again. */
function Row({ item, locale, onModal, canReopen, to }: {
  item: HistoryItem; locale: string; onModal: (modal: HistoryModal) => void; canReopen: (modal: HistoryModal) => boolean; to: AnnouncementRun;
}) {
  const title = item.source === "built-in" ? t(item.entry.title) : localized(item.card.title, locale);
  const body = item.source === "built-in" ? t(item.entry.body) : localized(item.card.body, locale);
  const words = <>
    <time dateTime={new Date(item.at).toISOString()} className="block text-[12px] leading-4 text-ink-tertiary">{dateText(item.at, locale)}</time>
    <span className="mt-0.5 block text-[14px] font-medium leading-5 text-ink">{title}</span>
    <span className="mt-0.5 line-clamp-2 block text-[13px] leading-[18px] text-ink-secondary">{body}</span>
  </>;
  const modal = item.source === "built-in" && "modal" in item.entry.open ? item.entry.open.modal : null;
  if (modal && canReopen(modal)) {
    return <li data-announcement-item={item.id}>
      <button type="button" onClick={() => onModal(modal)} className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-start transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-focus">
        <Mark item={item} />
        <span className="min-w-0 flex-1">{words}</span>
        <span className="ui-button ui-button-sm pointer-events-none mt-4 shrink-0 rounded-full px-3 text-[12px]">{t("announcements.showAgain")}</span>
      </button>
    </li>;
  }
  let buttons: ReactNode = null;
  if (item.source === "built-in" && item.ended) buttons = <span data-announcement-ended className="rounded-full bg-ink/[0.06] px-2.5 py-1 text-[12px] text-ink-secondary">{t("announcements.ended")}</span>;
  else if (item.source === "built-in" && "buttons" in item.entry.open) {
    buttons = item.entry.open.buttons.map((button, index) => <button key={button.label} type="button" className={index === 0 ? PRIMARY_BUTTON : QUIET_BUTTON}
      onClick={() => run(button.action, to)}>{t(button.label)}</button>);
  } else if (item.source === "feed") {
    buttons = [item.card.primary, item.card.secondary].flatMap((button, index) => button ? [<button key={index} type="button" className={index === 0 ? PRIMARY_BUTTON : QUIET_BUTTON}
      onClick={() => run(button.action, to)}>{localized(button.label, locale)}</button>] : []);
  }
  return <li data-announcement-item={item.id} className="flex items-start gap-3 px-3 py-3">
    <Mark item={item} />
    <div className="min-w-0 flex-1">
      {words}
      {buttons && <div className="mt-2.5 flex flex-wrap items-center gap-2">{buttons}</div>}
    </div>
  </li>;
}

/** The list itself, as the page draws it: newest first. */
export function AnnouncementList({ items, locale = activeLocale(), onModal, canReopen = () => true, to }: {
  items: readonly HistoryItem[]; locale?: string; onModal: (modal: HistoryModal) => void; canReopen?: (modal: HistoryModal) => boolean; to: AnnouncementRun;
}) {
  if (!items.length) {
    return <section aria-label={t("announcements.empty")} className="px-6 py-16 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Megaphone size={22} /></div>
      <p className="text-[14px] text-ink-secondary">{t("announcements.empty")}</p>
    </section>;
  }
  return <ul aria-label={t("announcements.title")} className="flex flex-col divide-y divide-hairline/40 rounded-2xl border border-hairline/50 bg-card/40">
    {items.map(item => <Row key={`${item.source}:${item.id}`} item={item} locale={locale} onModal={onModal} canReopen={canReopen} to={to} />)}
  </ul>;
}

/** The earlier What's new needs this desktop's Cloud account and the Admin's offer to say anything; null when it has nothing
 * for this account. */
function useWhatsNewView(found: Announcements, listed: boolean): WhatsNewView | null {
  const bridge = found.cloudBridge ? window.ogb?.cloudAccount : undefined;
  const [offer, setOffer] = useState<CloudOffer | null | undefined>(undefined);
  useEffect(() => {
    if (!listed || !bridge?.offer) return;
    let active = true;
    void bridge.offer().then(next => { if (active) setOffer(next); }, () => { if (active) setOffer(null); });
    return () => { active = false; };
  }, [listed, bridge]);
  const view = listed && bridge?.offer ? whatsNewView(found.account, offer) : "none";
  return typeof view === "object" ? view : null;
}

/** A popup from the list, opened again outside the notice queue: nothing about the queue's launch changes. */
function Replay({ modal, found, whatsNew, onClose }: { modal: HistoryModal; found: Announcements; whatsNew: WhatsNewView | null; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [moving, setMoving] = useState(false);
  const item = found.items.find(entry => entry.source === "built-in" && "modal" in entry.entry.open && entry.entry.open.modal === modal);
  const done = () => {
    if (item && !itemSeen(item, found.person)) rememberNoticeSeen(item.id, found.person.record, found.writer);
    onClose();
  };
  if (modal === "teams") {
    const action = teamsAction({ team: state.config?.team, viewer: found.viewer, account: found.account, canAddCloud: found.cloudBridge });
    return <TeamsPopup action={action} onStep={step => reportTeams(step, action)} onDone={done}
      onStart={() => dispatch({ type: "openCloudAdd", source: WHATS_NEW_SOURCES.team })} />;
  }
  if (modal === "whats-new") {
    if (!whatsNew) return null;
    return <WhatsNewPopup view={whatsNew} report={(action, slide) => reportWhatsNew(action, slide, whatsNew)} onDone={done}
      onBuy={slide => dispatch({ type: "openCloudAdd", source: WHATS_NEW_SOURCES[slide] })} />;
  }
  if (moving) return <GrokMoveDialog onClose={onClose} />;
  return <GrokMovePopup onDone={action => { if (action === "start") setMoving(true); else done(); }} />;
}

/** Everything announced to this person, newest first. Opening it clears the red dot (here and on their other pages). */
export function AnnouncementsPage() {
  const { dispatch } = useStore();
  const found = useAnnouncements();
  const [open, setOpen] = useState<HistoryModal | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const whatsNew = useWhatsNewView(found, found.items.some(item => item.source === "built-in" && "modal" in item.entry.open && item.entry.open.modal === "whats-new"));
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (found.unread) found.markRead(); }, [found.unread]);
  const to: AnnouncementRun = {
    url: url => void openExternalLink(url).catch(() => undefined),
    email: url => void openEmailDraft(url).catch(() => undefined),
    place: place => dispatch(announcementPlaceAction(place)),
    cloudAdd: source => dispatch({ type: "openCloudAdd", source }),
    cloudHowTo: () => dispatch({ type: "cloudHowTo", open: true }),
  };
  return (
    <ToolPage label={t("announcements.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("announcements.title")}</h1>
      </ToolPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-announcements={found.items.length}>
        <div className={cn("mx-auto w-full max-w-2xl p-4 sm:p-6")}>
          <AnnouncementList items={found.items} onModal={setOpen} canReopen={modal => modal !== "whats-new" || whatsNew !== null} to={to} />
        </div>
      </div>
      {open && <Replay modal={open} found={found} whatsNew={whatsNew} onClose={() => setOpen(null)} />}
    </ToolPage>
  );
}
