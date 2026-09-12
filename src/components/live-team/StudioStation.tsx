import { memo, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Coffee, Hand, Layers, Monitor, Send } from "lucide-react";
import { BotAvatar } from "../Avatar";
import type { Bot } from "@/state/store";
import type { StudioStation as Station } from "../../../shared/live-team";
import type { StationState } from "@/lib/live-team";
import { t } from "@/lib/i18n";

/** How long a desk sits idle before its bot dozes off, then fully sleeps. */
const DROWSY_AFTER_MS = 20_000;
const ASLEEP_AFTER_MS = 60_000;
/** How long the coffee cup lingers when a bot picks up a new task. */
const COFFEE_MS = 1800;

/** A desk naps once nothing is happening on it, whether that's because the bot has no
 * work or because its engine isn't wired up yet: both look like an empty desk. */
const IDLE_STATUSES: ReadonlySet<StationState> = new Set(["ready", "unavailable"]);

/** Nap stage for an idle desk, tracked locally: purely presentational, never sent to the server. */
function useNap(status: StationState, calm: boolean): { nap: "awake" | "drowsy" | "asleep"; wakeBeat: number } {
  const [nap, setNap] = useState<"awake" | "drowsy" | "asleep">("awake");
  const wasAsleep = useRef(false);
  const [wakeBeat, setWakeBeat] = useState(0);
  useEffect(() => {
    if (calm || !IDLE_STATUSES.has(status)) {
      setNap("awake");
      if (wasAsleep.current) setWakeBeat((beat) => beat + 1);
      wasAsleep.current = false;
      return;
    }
    const drowsy = setTimeout(() => setNap("drowsy"), DROWSY_AFTER_MS);
    const asleep = setTimeout(() => { setNap("asleep"); wasAsleep.current = true; }, ASLEEP_AFTER_MS);
    return () => { clearTimeout(drowsy); clearTimeout(asleep); };
  }, [status, calm]);
  return { nap, wakeBeat };
}

/** Fires a coffee run for a beat whenever a desk picks up new work. */
function useCoffeeRun(status: StationState, calm: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const previous = useRef(status);
  useEffect(() => {
    if (status === "working" && previous.current !== "working" && !calm) {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), COFFEE_MS);
      previous.current = status;
      return () => clearTimeout(timer);
    }
    previous.current = status;
  }, [status, calm]);
  return visible;
}

/** Render a stable bot workstation with task, assistance, and assignment controls. */
export const StudioStation = memo(function StudioStation({ bot, station, status, calm, lampsOn, selected, onOpen, onComputer, onAssign, onTasks, onAttention, onSelect }: {
  locale: string; bot: Bot; station?: Station; status: StationState; calm: boolean; lampsOn: boolean; selected: boolean;
  onOpen: (botId: string) => void; onComputer: (botId: string) => void; onAssign: (botId: string) => void;
  onTasks: (botId: string) => void; onAttention: (botId: string) => void; onSelect: (botId: string) => void;
}) {
  const busy = status === "working";
  const waiting = status === "waiting";
  const { nap, wakeBeat } = useNap(status, calm);
  const coffee = useCoffeeRun(status, calm);
  const asleep = nap === "asleep";
  const avatarState = waiting ? "alerting" : busy ? "working" : asleep ? "sleeping" : nap === "drowsy" ? "drowsy" : "idle";
  return <article className="studio-station" data-station={bot.id} data-state={status} data-nap={nap} data-selected={selected}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-omb-studio-brief")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
    onDrop={(event) => { if (event.dataTransfer.types.includes("application/x-omb-studio-brief")) { event.preventDefault(); onAssign(bot.id); } }}
    onFocus={() => onSelect(bot.id)} aria-label={t("studio.station", { name: bot.name })}>
    <div className="studio-desk-scene" data-lamp={lampsOn}>
      <div className="studio-chair" aria-hidden="true" />
      <div className="studio-maus">
        <BotAvatar bot={bot} size={110} state={avatarState} animated={!calm && (busy || waiting || nap !== "awake")} trackPointer={false} motion={wakeBeat ? "switch" : "none"} motionKey={wakeBeat} />
        {asleep && <span className="studio-zzz" aria-hidden="true">z z z</span>}
        {coffee && <span className="studio-coffee" aria-hidden="true"><Coffee size={16} /></span>}
      </div>
      <div className="studio-desk" aria-hidden="true"><span className="studio-desk-front" /><span className="studio-desk-leg" /><span className="studio-desk-leg second" /></div>
      <div className="studio-lamp" aria-hidden="true"><span /><i /></div>
      <button type="button" className="studio-monitor" onClick={() => onComputer(bot.id)} aria-label={t("studio.openComputer", { name: bot.name })}><Monitor size={27} /><span>{t("studio.computer")}</span></button>
      <button type="button" className="studio-task-stack" onClick={() => onTasks(bot.id)} aria-label={t("studio.openTasks", { name: bot.name })}><Layers size={19} /><span>{station?.threads.length ?? 0}</span></button>
      {waiting && <button type="button" className="studio-hand" onClick={() => onAttention(bot.id)} aria-label={t("studio.needsYou", { name: bot.name })}><Hand size={21} /></button>}
    </div>
    <div className="studio-nameplate">
      <button type="button" onClick={() => onOpen(bot.id)}><strong>{bot.name}</strong><ArrowUpRight size={14} /></button>
      <span className="studio-role">{bot.title || bot.modelSelection.model}</span>
      <span className="studio-status"><i aria-hidden="true" />{asleep ? t("studio.state.asleep") : t(`studio.state.${status}`)}</span>
      {station?.threads[0] && <span className="studio-current-task">{station.threads[0].title}</span>}
    </div>
    <button type="button" className="studio-assign" onClick={() => onAssign(bot.id)}><Send size={13} />{t("studio.assign")}</button>
  </article>;
});
