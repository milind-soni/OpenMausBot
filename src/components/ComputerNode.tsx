import { memo } from "react";
import { Loader2, Moon, MonitorOff, TriangleAlert } from "lucide-react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { MONITOR_HEIGHT, MONITOR_WIDTH } from "@/lib/team-canvas-computers";
import type { MapComputer, MapComputerState } from "../../shared/map-computer";
import { BotAvatar } from "./Avatar";

const STATE_LABEL: Record<MapComputerState, LocaleKey> = {
  starting: "mapComputer.state.starting",
  working: "mapComputer.state.working",
  idle: "mapComputer.state.idle",
  asleep: "mapComputer.state.asleep",
  off: "mapComputer.state.off",
  problem: "mapComputer.state.problem",
};
const STATE_DOT: Record<MapComputerState, string> = {
  starting: "bg-warning",
  working: "bg-success",
  idle: "bg-sky-400",
  asleep: "bg-white/35",
  off: "bg-white/25",
  problem: "bg-danger",
};

/** A bot's computer on the Team map: a small monitor with its live screen, state and the bots that use it. */
export const ComputerNode = memo(function ComputerNode({ computer, bots, frameUrl, state, activity, x, y, onOpen }: {
  computer: MapComputer;
  bots: Bot[];
  frameUrl?: string;
  state: MapComputerState;
  activity?: string;
  x: number;
  y: number;
  onOpen?: () => void;
}) {
  const live = state === "working";
  const name = computer.kind === "team" ? computer.name : t("mapComputer.botComputer", { name: computer.name });
  return <div data-computer-node={computer.id} className="absolute" style={{ left: x, top: y, width: MONITOR_WIDTH, height: MONITOR_HEIGHT }}>
    {live && <span aria-hidden className="pointer-events-none absolute -inset-[5px] animate-computer-glow rounded-[22px] border-2 border-success/70 shadow-[0_0_24px_rgba(52,199,89,0.35)]" />}
    <button type="button" onClick={onOpen} disabled={!onOpen} title={activity ? `${name} · ${activity}` : name}
      aria-label={t("mapComputer.open", { name, state: t(STATE_LABEL[state]) })}
      className="relative flex size-full flex-col rounded-[18px] border border-white/10 bg-[#0f1117] p-2 text-left shadow-[0_10px_30px_rgba(0,0,0,0.35)] outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default">
      <span className="relative block h-[160px] w-full overflow-hidden rounded-[10px] bg-[#06070b] [contain:paint]">
        {frameUrl
          ? <img src={frameUrl} alt="" draggable={false} decoding="async" className={cn("size-full object-cover", state === "asleep" || state === "off" ? "opacity-40 grayscale" : "")} />
          : <span className="flex size-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_50%_40%,#1b2030,#06070b_70%)] text-[11px] text-white/45">
            {state === "starting" ? <Loader2 size={20} className="animate-spin" /> : state === "asleep" ? <Moon size={20} /> : state === "problem" ? <TriangleAlert size={20} /> : <MonitorOff size={20} />}
            {t(state === "starting" ? "mapComputer.empty.starting" : state === "asleep" ? "mapComputer.empty.asleep" : state === "problem" ? "mapComputer.empty.problem" : state === "off" ? "mapComputer.empty.off" : "mapComputer.empty.waiting")}
          </span>}
        <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-[2px]">
          <span className={cn("size-1.5 rounded-full", STATE_DOT[state], live && "animate-pulse")} />{t(STATE_LABEL[state])}
        </span>
        {activity && live && <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 via-black/55 to-transparent px-2.5 pb-1.5 pt-6 text-[11px] leading-tight text-white/90">{activity}</span>}
      </span>
      <span className="flex h-[32px] min-w-0 items-center gap-2 px-1 pt-1.5">
        <span className="flex shrink-0 -space-x-1.5">
          {bots.slice(0, 3).map((bot) => <span key={bot.id} className="rounded-full ring-2 ring-[#0f1117]"><BotAvatar bot={bot} size={20} animated={false} motion="none" motionKey={0} /></span>)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-white/90">{name}</span>
        {bots.length > 3 && <span className="shrink-0 text-[10px] text-white/50">+{bots.length - 3}</span>}
      </span>
    </button>
  </div>;
});
