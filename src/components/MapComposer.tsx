import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";
import { openBot, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { mentionChoicesForQuery, mentionQueryAt } from "@/lib/mentions";
import { mapMessageTargets, sentToSummary } from "@/lib/map-composer";
import { imeComposing, sendsMessage, useSendKey } from "@/lib/send-key";
import { useShowThreads } from "@/lib/thread-preferences";
import { MentionMenu, type MentionChoice } from "./MentionMenu";
import { MentionTextarea } from "./MentionTextarea";
import { useMenuMotion } from "./MenuMotion";

/** Message bots from the Team map: tag bots, a team or @everyone; each tagged bot gets it as a normal message in its own chat. */
export function MapComposer({ bots, teams, onTagged, onSent }: {
  bots: Bot[];
  teams: Array<{ key: string; name: string; count: number }>;
  onTagged: (botIds: string[]) => void;
  /** The bots a message just went to, so their cards can acknowledge it. */
  onSent: (botIds: string[]) => void;
}) {
  const { dispatch } = useStore();
  const showThreads = useShowThreads();
  const sendKey = useSendKey();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [sent, setSent] = useState<{ botIds: string[]; expanded: boolean } | null>(null);

  const visible = useMemo(() => bots.filter((bot) => !bot.hidden), [bots]);
  const targets = useMemo(() => mapMessageTargets(text, visible, teams), [text, visible, teams]);
  const targetKey = targets.botIds.join(",");
  useEffect(() => { onTagged(targetKey ? targetKey.split(",") : []); }, [targetKey, onTagged]);
  useEffect(() => () => onTagged([]), [onTagged]);

  const mention = mentionQueryAt(text, caret);
  const choices = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = [
      ...(visible.length > 1 ? [{ id: "__everyone__", name: "everyone", all: { count: visible.length } }] : []),
      ...teams.filter((team) => team.count > 0).map((team) => ({ id: `team:${team.key}`, name: team.name, team: { count: team.count } })),
      ...visible.map((bot) => ({ id: bot.id, name: bot.name, bot })),
    ];
    return mentionChoicesForQuery(pool, mention.query);
  }, [mention, dismissedAt, visible, teams]);
  const pickerOpen = choices.length > 0;
  const motion = useMenuMotion(pickerOpen);
  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);
  useEffect(() => {
    if (pickerOpen) listRef.current?.querySelector<HTMLElement>(`[data-mention-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight, pickerOpen]);

  const pick = (choice: MentionChoice) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${choice.name} ${text.slice(caret)}`;
    const nextCaret = mention.start + choice.name.length + 2;
    setText(next);
    setCaret(nextCaret);
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const canSend = text.trim().length > 0 && targets.botIds.length > 0;
  const send = () => {
    if (!canSend) return;
    const message = text.trim();
    for (const botId of targets.botIds) dispatch({ type: "send", botId, text: message, sendId: crypto.randomUUID() });
    onSent(targets.botIds);
    setSent({ botIds: targets.botIds, expanded: false });
    setText("");
    setCaret(0);
    setDismissedAt(null);
  };

  const names = (sent?.botIds ?? []).flatMap((id) => visible.find((bot) => bot.id === id) ?? []);
  const summary = sentToSummary(names.map((bot) => bot.name));
  const shownNames = sent?.expanded ? names : names.slice(0, summary.names.length);
  const hint = text.trim() && !targets.botIds.length ? t("mapComposer.tagHint") : null;

  return <>
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-[620px]">
        {sent && names.length > 0 && <p role="status" className="mb-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 rounded-xl bg-panel/95 px-3 py-1.5 text-[12px] text-ink-secondary shadow-sm ring-1 ring-hairline/50">
          <span>{t("mapComposer.sentTo")}</span>
          {shownNames.map((bot, index) => <span key={bot.id}>
            <button className="font-medium text-ink underline-offset-2 hover:underline" onClick={() => openBot(dispatch, bot, showThreads)}>{bot.name}</button>
            {index < shownNames.length - 1 ? "," : ""}
          </span>)}
          {!sent.expanded && summary.more > 0 && <button className="text-ink underline-offset-2 hover:underline" onClick={() => setSent({ ...sent, expanded: true })}>{t("mapComposer.andMore", { count: summary.more })}</button>}
          <button aria-label={t("common.close")} className="ml-auto rounded p-0.5 hover:bg-control" onClick={() => setSent(null)}><X size={12} /></button>
        </p>}
        <div className="relative flex items-end gap-2 rounded-2xl bg-composer px-3 py-2 shadow-lg ring-1 ring-composer-ring">
          <MentionMenu listRef={listRef} motion={motion} choices={choices} highlight={highlight} everyoneCount={visible.length}
            onPick={pick} onHighlight={setHighlight} />
          <MentionTextarea inputRef={inputRef} peers={[...visible, ...teams.map((team) => ({ name: team.name }))]} everyone
            aria-label={t("mapComposer.label")} placeholder={t("mapComposer.placeholder")} dir="auto" rows={1} value={text}
            className="block max-h-[9rem] min-h-6 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-[15px] leading-6 placeholder:text-ink-secondary focus:outline-none"
            onChange={(event) => { setText(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); setDismissedAt(null); }}
            onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onClick={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(event) => {
              if (imeComposing(event.nativeEvent)) return;
              if (pickerOpen) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlight((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(choices[highlight]); return; }
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissedAt(mention?.start ?? null); return; }
              }
              if (sendsMessage(event.nativeEvent, sendKey)) { event.preventDefault(); send(); }
            }} />
          <button onClick={send} disabled={!canSend} aria-label={t("mapComposer.send")}
            title={!canSend ? t("mapComposer.tagHint") : targets.botIds.length === 1 ? t("mapComposer.sendToOne") : t("mapComposer.sendTo", { count: targets.botIds.length })}
            className={cn("mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-white transition-opacity", canSend ? "bg-accent hover:brightness-110" : "bg-ink-secondary/30")}>
            <ArrowUp size={16} />
          </button>
        </div>
        {(hint || targets.botIds.length > 0) && <p className="mt-1.5 px-3 text-[11px] text-ink-secondary">
          {hint ?? (targets.botIds.length === 1 ? t("mapComposer.willSendOne") : t("mapComposer.willSend", { count: targets.botIds.length }))}
        </p>}
      </div>
    </div>
  </>;
}
