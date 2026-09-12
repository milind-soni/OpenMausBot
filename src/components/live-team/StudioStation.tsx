import { memo } from "react";
import { ArrowUpRight, Hand, Layers, Monitor, Send } from "lucide-react";
import { BotAvatar } from "../Avatar";
import type { Bot } from "@/state/store";
import type { StudioStation as Station } from "../../../shared/live-team";
import type { StationState } from "@/lib/live-team";
import { t } from "@/lib/i18n";

/** Render a stable bot workstation with task, assistance, and assignment controls. */
export const StudioStation = memo(function StudioStation({ bot, station, status, calm, selected, onOpen, onComputer, onAssign, onTasks, onAttention, onSelect }: {
  locale: string; bot: Bot; station?: Station; status: StationState; calm: boolean; selected: boolean;
  onOpen: (botId: string) => void; onComputer: (botId: string) => void; onAssign: (botId: string) => void;
  onTasks: (botId: string) => void; onAttention: (botId: string) => void; onSelect: (botId: string) => void;
}) {
  const busy = status === "working";
  const waiting = status === "waiting";
  return <article className="studio-station" data-station={bot.id} data-state={status} data-selected={selected}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-omb-studio-brief")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
    onDrop={(event) => { if (event.dataTransfer.types.includes("application/x-omb-studio-brief")) { event.preventDefault(); onAssign(bot.id); } }}
    onFocus={() => onSelect(bot.id)} aria-label={t("studio.station", { name: bot.name })}>
    <div className="studio-desk-scene">
      <div className="studio-chair" aria-hidden="true" />
      <div className="studio-maus"><BotAvatar bot={bot} size={110} state={waiting ? "alerting" : busy ? "working" : "idle"} animated={!calm && (busy || waiting)} trackPointer={false} motion="none" /></div>
      <div className="studio-desk" aria-hidden="true"><span className="studio-desk-front" /><span className="studio-desk-leg" /><span className="studio-desk-leg second" /></div>
      <div className="studio-lamp" aria-hidden="true"><span /><i /></div>
      <button type="button" className="studio-monitor" onClick={() => onComputer(bot.id)} aria-label={t("studio.openComputer", { name: bot.name })}><Monitor size={27} /><span>{t("studio.computer")}</span></button>
      <button type="button" className="studio-task-stack" onClick={() => onTasks(bot.id)} aria-label={t("studio.openTasks", { name: bot.name })}><Layers size={19} /><span>{station?.threads.length ?? 0}</span></button>
      {waiting && <button type="button" className="studio-hand" onClick={() => onAttention(bot.id)} aria-label={t("studio.needsYou", { name: bot.name })}><Hand size={21} /></button>}
    </div>
    <div className="studio-nameplate">
      <button type="button" onClick={() => onOpen(bot.id)}><strong>{bot.name}</strong><ArrowUpRight size={14} /></button>
      <span className="studio-role">{bot.title || bot.modelSelection.model}</span>
      <span className="studio-status"><i aria-hidden="true" />{t(`studio.state.${status}`)}</span>
      {station?.threads[0] && <span className="studio-current-task">{station.threads[0].title}</span>}
    </div>
    <button type="button" className="studio-assign" onClick={() => onAssign(bot.id)}><Send size={13} />{t("studio.assign")}</button>
  </article>;
});
