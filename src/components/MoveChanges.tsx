// The move step's "what changes": a few lines from the chosen bots' real setup (shared/move-changes.ts), and what the
// person can let them use on this computer from My Cloud. Nothing is lent here: the choice goes with Move, and main asks
// its own dialog before commands are lent. Phrasing content only: it sits inside the confirm's paragraph.
import { useEffect, useState, type ReactNode } from "react";
import type { MoveChoice, MoveFacts, MoveLending } from "../../shared/move-changes.ts";
import { MOVE_LINES_SHOWN, defaultMoveChoice, moveChanges, moveOffers } from "../../shared/move-changes.ts";
import { t } from "@/lib/i18n";
import { moveChangeText } from "@/lib/move-changes";
import { usePlacesTogether } from "@/lib/places-together";
import { Switch } from "./SettingsPrimitives";

const bridge = () => (!window.ogb?.remoteClient?.active ? window.ogb?.cloudSendPage : undefined);

type Known = { facts: MoveFacts; lending: Omit<MoveLending, "together"> };

/** "on" or "off" when this computer's page can turn the link on, else "unavailable". */
function togetherState(together: ReturnType<typeof usePlacesTogether>): MoveLending["together"] {
  if (together?.on) return "on";
  return together?.available && together.here === "computer" ? "off" : "unavailable";
}

function Choice({ on, label, hint, onChange, id }: { on: boolean; label: string; hint?: string; onChange(next: boolean): void; id: string }) {
  return <span className="flex items-start gap-2.5 py-1" data-move-choice={id}>
    {/* Off, the track shows on the dialog's own colour too. */}
    <Switch compact checked={on} aria-label={label} onClick={() => onChange(!on)} className={on ? "mt-0.5" : "mt-0.5 bg-ink/20"} />
    <span className="flex min-w-0 flex-col">
      <span className="text-ink" dir="auto">{label}</span>
      {hint && <span className="text-[12px] leading-4 text-ink-tertiary">{hint}</span>}
    </span>
  </span>;
}

/** What the caller passes to Move: `folder` only when the step offered it (left out, the move lends the working folders as
 * it always did), `commands` and `together` as the person set them. */
export type MoveOptions = { folder?: boolean; commands: boolean; together: boolean };

/** How long the chooser waits after a tick before it reads what the choice changes. */
const READ_AFTER_MS = 250;

/** What moving `ids` changes, as the confirm or the chooser shows it; `bot` names the one bot moving. `choice` is what the
 * person lets them use, which the caller passes to Move; what they set themselves stays set while the bots ticked change. */
export function useMoveChanges(ids: readonly string[], bot: string | null): { view: ReactNode; choice: MoveOptions | null } {
  const key = ids.join(",");
  const [known, setKnown] = useState<{ key: string; value: Known | null } | null>(null);
  const [mine, setMine] = useState<Partial<MoveChoice>>({});
  const [all, setAll] = useState(false);
  const together = togetherState(usePlacesTogether());
  useEffect(() => {
    if (!key) { setKnown(null); setMine({}); return; }
    let alive = true;
    const read = bridge()?.moveChanges;
    if (!read) return;
    const go = () => void read(key.split(",")).then((value) => {
      if (!alive) return;
      setKnown({ key, value });
      setAll(false);
    }, () => { if (alive) setKnown({ key, value: null }); });
    // One bot is read at once; a choice waits for the ticks to settle.
    const timer = key.includes(",") ? setTimeout(go, READ_AFTER_MS) : (go(), null);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [key]);
  // While a new choice of bots is read, the last answer stays on screen, and what the person set stays theirs: Move then
  // never lends a folder they turned off.
  const value = known?.value ?? null;
  const lending: MoveLending | null = value ? { ...value.lending, together } : null;
  const fresh = known?.key === key;
  if (!value || !lending) return { view: null, choice: key ? { ...(mine.folder === false ? { folder: false } : {}), commands: mine.commands === true, together: mine.together === true } : null };
  const offers = moveOffers(value.facts, lending);
  const choice: MoveChoice = { ...defaultMoveChoice(value.facts, lending), ...mine };
  const options: MoveOptions = fresh
    ? { ...(offers.folder ? { folder: choice.folder } : {}), commands: offers.commands && choice.commands, together: offers.together && choice.together }
    : { ...(mine.folder === false ? { folder: false } : {}), commands: mine.commands === true, together: mine.together === true };
  const lines = moveChanges(value.facts, lending, { folder: offers.folder ? choice.folder : false, commands: options.commands, together: options.together });
  if (!lines.length && !offers.folder && !offers.commands) return { view: null, choice: options };
  const shown = all ? lines : lines.slice(0, MOVE_LINES_SHOWN);
  const set = (change: Partial<MoveChoice>) => setMine({ ...mine, ...change });
  const view = <span data-move-changes={lines.map((line) => line.kind).join(" ")} className="mt-1 flex flex-col">
    {lines.length > 0 && <>
      <span className="font-medium text-ink" dir="auto">{bot ? t("cloudSend.changes.title", { bot }) : t("cloudSend.changes.titleMany")}</span>
      <span role="list" className="mt-1 flex flex-col gap-1">
        {shown.map((line) => <span role="listitem" key={line.kind} data-move-change={line.kind} className="flex gap-2">
          <span aria-hidden="true" className="mt-[9px] size-1 shrink-0 rounded-full bg-ink-tertiary" />
          <span dir="auto">{moveChangeText(line, value.facts)}</span>
        </span>)}
      </span>
      {lines.length > shown.length && <button type="button" data-move-changes-more="" onClick={() => setAll(true)}
        className="mt-1 self-start text-[12px] font-medium text-accent-text hover:text-ink">{t("cloudSend.changes.more", { count: lines.length - shown.length })}</button>}
    </>}
    {(offers.folder || offers.commands) && <span className="mt-2.5 flex flex-col border-t border-hairline/40 pt-1.5">
      {offers.folder && value.facts.folder && <Choice id="folder" on={choice.folder} onChange={(on) => set({ folder: on })}
        label={value.facts.folders > 1 ? t("cloudSend.changes.lendFolders") : bot ? t("cloudSend.changes.lendFolder", { bot, folder: value.facts.folder }) : t("cloudSend.changes.lendFolderMany", { folder: value.facts.folder })} />}
      {offers.commands && <Choice id="commands" on={choice.commands} onChange={(on) => set({ commands: on })}
        label={t("cloudSend.changes.lendCommands")} hint={t("cloudSend.changes.lendCommandsHint")} />}
    </span>}
  </span>;
  return { view, choice: options };
}
