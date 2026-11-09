// Moving some of this computer's bots to My Cloud, in the desktop app only: the dialog that asks which ones before the first
// move ("Move everything" as the quick way), a bot's own "Move to My Cloud" in its menu, the line that says how it goes,
// and the one row the bots that moved leave in the sidebar. Main runs the move (electron/bot-move-main.mjs).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, Check, Cloud, Loader2, X } from "lucide-react";
import type { BotMoveState, BotMoveView } from "../../electron/cloud-send.mjs";
import { botMoveLine, chooserBots, filterBots, ipcErrorText, CHOOSER_PAGE, MY_CLOUD_TEAM } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

type MenuItem = (icon: ReactNode, label: string, onClick?: () => void, opts?: { disabled?: boolean; hint?: string }) => ReactNode;

const bridge = () => (!window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined);

/** Which bots go to My Cloud: any of them, found by name, or everything with one press. */
export function MoveChooser({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const bots = useMemo(() => chooserBots(state.bots), [state.bots]);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(CHOOSER_PAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const found = useMemo(() => filterBots(bots, query), [bots, query]);
  const allFound = found.length > 0 && found.every((bot) => chosen.has(bot.id));
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const toggle = (id: string) => setChosen((before) => {
    const next = new Set(before);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const toggleFound = () => setChosen((before) => {
    const next = new Set(before);
    for (const bot of found) if (allFound) next.delete(bot.id); else next.add(bot.id);
    return next;
  });
  const go = (work: (() => Promise<unknown>) | undefined) => {
    if (!work) return;
    setBusy(true);
    setError(null);
    void work().then(onClose, (cause: unknown) => setError(ipcErrorText(cause) ?? t("cloudSend.choose.failed"))).finally(() => setBusy(false));
  };
  const page = bridge();
  return createPortal(<div className="ui-scrim fixed inset-0 z-[80] flex items-center justify-center p-4">
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby="move-chooser-title" data-move-chooser=""
      className="ui-modal relative flex max-h-[min(640px,calc(100dvh-32px))] w-[min(440px,calc(100vw-32px))] flex-col border-0 p-5 text-ink">
      <h2 id="move-chooser-title" className="pe-8 text-[17px] font-semibold">{t("cloudSend.choose.title")}</h2>
      <p className="mt-1 text-[14px] leading-5 text-ink-secondary">{t("cloudSend.choose.line")}</p>
      <button type="button" disabled={busy} data-move-everything="" className={`${PRIMARY_BUTTON} mt-4 w-full justify-center`}
        onClick={() => go(page?.moveEverything)}>{t("cloudSend.choose.everything")}</button>
      <div className="mt-4 flex items-center gap-2">
        <input type="search" value={query} placeholder={t("cloudSend.choose.search")} aria-label={t("cloudSend.choose.search")} data-move-search=""
          onChange={(event) => { setQuery(event.target.value); setShown(CHOOSER_PAGE); }} className="min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none disabled:opacity-50" />
        <button type="button" data-move-select-all="" disabled={!found.length} onClick={toggleFound} className="ui-button whitespace-nowrap px-2.5 py-1.5 text-[13px]">
          {t(allFound ? "cloudSend.choose.clear" : "cloudSend.choose.selectAll")}
        </button>
      </div>
      <ul className="mt-2 min-h-[120px] flex-1 overflow-y-auto rounded-md border border-hairline" data-move-bots="">
        {found.slice(0, shown).map((bot) => {
          const on = chosen.has(bot.id);
          return <li key={bot.id}>
            <button type="button" role="checkbox" aria-checked={on} data-move-bot={bot.id} onClick={() => toggle(bot.id)} className="flex w-full items-center gap-2.5 px-3 py-2 text-start text-[14px] hover:bg-raised">
              <BotAvatar bot={bot} size={22} animated={false} />
              <span className="min-w-0 flex-1 truncate" dir="auto">{bot.name}</span>
              {on && <Check size={15} aria-hidden="true" />}
            </button>
          </li>;
        })}
        {!found.length && <li className="px-3 py-3 text-[13px] text-ink-tertiary">{t("cloudSend.choose.none")}</li>}
        {found.length > shown && <li><button type="button" data-move-more="" className="w-full px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised" onClick={() => setShown((count) => count + CHOOSER_PAGE)}>
          {t("cloudSend.choose.more", { count: found.length - shown })}
        </button></li>}
      </ul>
      <p className="mt-2 text-[12px] text-ink-tertiary">{t("cloudSend.choose.rooms")}</p>
      {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
      <button type="button" disabled={busy || !chosen.size} data-move-chosen="" className="ui-button mt-3 w-full justify-center py-1.5 text-[14px]" onClick={() => go(page?.moveBots && (() => page.moveBots!([...chosen])))}>
        {busy && <Loader2 size={14} aria-hidden="true" className="me-1.5 animate-spin" />}
        {chosen.size === 1 ? t("cloudSend.choose.moveOne") : t("cloudSend.choose.moveSome", { count: chosen.size })}
      </button>
      <div className="mt-1 flex justify-center"><NotNowButton onClick={onClose} /></div>
      <button type="button" onClick={onClose} aria-label={t("common.close")} className="ui-icon-button absolute end-3 top-3"><X size={16} /></button>
    </div>
  </div>, document.body);
}

/** Whether this computer's bots can move to My Cloud now, read again each time the window is back in front. */
function useBotMoveState(): BotMoveState | null {
  const [known, setKnown] = useState<BotMoveState | null>(null);
  useEffect(() => {
    const page = bridge();
    if (!page?.botMoveState) return;
    let alive = true;
    const read = () => void page.botMoveState!().then((next) => { if (alive) setKnown(next); }, () => { if (alive) setKnown(null); });
    read();
    window.addEventListener("focus", read);
    return () => { alive = false; window.removeEventListener("focus", read); };
  }, []);
  return known;
}

/** A bot's own "Move to My Cloud", and the one confirm it opens. */
export function useMoveToMyCloud() {
  const known = useBotMoveState();
  const [asked, setAsked] = useState<Bot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    const page = bridge();
    if (!asked || !page?.moveBots) return;
    setBusy(true);
    setError(null);
    void page.moveBots([asked.id]).then(() => setAsked(null), (cause: unknown) => setError(ipcErrorText(cause) ?? t("cloudSend.choose.failed"))).finally(() => setBusy(false));
  };
  const names = { bot: asked?.name ?? "" };
  return {
    items(bot: Bot, item: MenuItem): ReactNode[] {
      if (!known?.available || bot.defaultBot || bot.movedTo || known.moving.includes(bot.id)) return [];
      return [item(<Cloud size={16} className="text-ink-secondary" />, t("cloudSend.botMove.menu"), () => { setError(null); setAsked(bot); })];
    },
    dialog: <ConfirmDialog open={asked !== null} tone="neutral" icon={<Cloud size={18} />} title={t("cloudSend.botMove.confirmTitle", names)}
      body={<span className="flex flex-col gap-2" data-bot-move-confirm="">
        <span>{t("cloudSend.botMove.confirmBody", names)}</span>
        {error && <span role="alert" className="text-danger">{error}</span>}
      </span>}
      confirmLabel={t("cloudSend.botMove.confirm")} pending={busy} onCancel={() => setAsked(null)} onConfirm={confirm} />,
  };
}

/** The one row the bots that moved to My Cloud leave in the sidebar: however many there are, it opens My Cloud. */
export function MovedToMyCloudRow({ bots }: { bots: readonly Bot[] }) {
  const moved = bots.filter((bot) => bot.movedTo?.state === "moved" && bot.movedTo.team.id === MY_CLOUD_TEAM);
  if (!moved.length) return null;
  const page = bridge();
  return <div className="flex flex-col px-2 pb-1">
    <button type="button" data-moved-to-my-cloud={moved.length} disabled={!page?.openMyCloud} onClick={() => { void page?.openMyCloud?.().catch(() => {}); }}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-secondary enabled:hover:bg-menu-hover enabled:hover:text-ink">
      <ArrowRightLeft size={14} aria-hidden="true" className="shrink-0" />
      <span className="truncate" dir="auto">{moved.length === 1 ? t("cloudSend.botMove.movedOne", { bot: moved[0]!.name }) : t("cloudSend.botMove.movedMany", { count: moved.length })}</span>
    </button>
  </div>;
}

/** How the chosen bots' move goes: on its way, failed (it tries again by itself), or done. */
export function BotMoveLine({ move, onChange }: { move: BotMoveView; onChange(next: BotMoveView | null): void }) {
  const page = bridge();
  const line = botMoveLine(move);
  const link = "font-medium text-accent-text underline underline-offset-2 hover:text-ink";
  return <div role="status" data-cloud-send-strip={line.kind} data-bot-move-line={move.phase} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
    {line.kind === "sending" ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <ArrowRightLeft size={14} aria-hidden="true" />}
    <span dir="auto" data-cloud-send-strip-line>{line.text}</span>
    {line.kind === "done" && page?.openMyCloud && <button type="button" className={link} onClick={() => { void page.openMyCloud!().catch(() => {}); }}>{t("cloudSend.botMove.open")}</button>}
    {line.kind === "failed" && page?.botMoveRetry && <button type="button" className={link} onClick={() => { void page.botMoveRetry!().then(onChange).catch(() => {}); }}>{t("cloudSend.strip.retry")}</button>}
    {line.kind !== "sending" && <button type="button" className="hover:text-ink" onClick={() => { void page?.dismiss("bot-move").then(() => onChange(null)).catch(() => {}); }}>{t("cloudSend.strip.close")}</button>}
  </div>;
}
