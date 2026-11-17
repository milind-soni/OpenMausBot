// The other place's bots in this sidebar, while "This computer and My Cloud together" is on: a group of their own under
// this place's bots. A row opens its bot where it lives; main switches the window there.
import { useState } from "react";
import { Cloud } from "lucide-react";
import { BOT_BODY_IDS, type BotBodyId } from "../../shared/bot-body";
import { MASCOT_FACE_COLORS, type MascotFaceColor } from "../../shared/bot-avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { MAUS_COLOR_NAMES, type MausColor } from "@/lib/mascot";
import { matchingRows, openOtherPlaceBot, placedKey, usePlacesTogether, type BotHome, type PlaceBotRow, type PlacesTogetherState } from "@/lib/places-together";
import { useSidebarDensity } from "@/lib/sidebar-preferences";
import { BotAvatar } from "./Avatar";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SIMPLE_ROW_FOCUS } from "./SidebarSimpleTop";

type OtherState = NonNullable<PlacesTogetherState["other"]>["state"];

const homeLabel = (home: BotHome): string => t(home === "cloud" ? "together.onCloud" : "together.onComputer");

function stateLine(state: OtherState, home: BotHome): string | null {
  if (state === "asleep") return t("together.state.asleep");
  if (state === "waking") return t("together.state.waking");
  if (state === "signin") return t("together.state.signin");
  if (state === "offline") return t(home === "cloud" ? "together.state.offlineCloud" : "together.state.offlineComputer");
  return null;
}

/** The small cloud a bot that lives on My Cloud carries beside its name. */
export function CloudBotMark({ className }: { className?: string }) {
  return <Cloud size={12} role="img" aria-label={t("together.onCloud")} data-bot-home="cloud" className={cn("shrink-0 text-ink-secondary", className)}><title>{t("together.onCloud")}</title></Cloud>;
}

/** The same mark on this page's own rows, when this page is My Cloud's and both places are listed together. */
export function OwnBotHomeMark() {
  const together = usePlacesTogether();
  return together?.on && together.here === "cloud" ? <CloudBotMark /> : null;
}

function avatarOf(row: PlaceBotRow) {
  const color = (MAUS_COLOR_NAMES as readonly string[]).includes(row.color ?? "") ? row.color as MausColor : "green";
  const body = (BOT_BODY_IDS as readonly string[]).includes(row.mascotBody ?? "") ? row.mascotBody as BotBodyId : null;
  const face = (MASCOT_FACE_COLORS as readonly string[]).includes(row.mascotFaceColor ?? "") ? row.mascotFaceColor as MascotFaceColor : null;
  return { name: row.name, color, mascotBody: body, mascotFaceColor: face };
}

function OtherPlaceBotRow({ row, dim, iconOnly, simple }: { row: PlaceBotRow; dim: boolean; iconOnly: boolean; simple: boolean }) {
  const line = row.waiting ? t("sidebar.preview.waiting") : row.working ? t("sidebar.preview.working") : row.title ?? "";
  const label = [row.name, homeLabel(row.home), line, row.unread ? t("task.unread") : ""].filter(Boolean).join(" · ");
  return (
    <button type="button" data-placed-bot={placedKey(row.home, row.id)} data-bot-home={row.home} data-bot-address={row.address} title={iconOnly ? label : undefined} aria-label={label}
      onClick={() => openOtherPlaceBot(row.id)}
      className={cn("flex w-full items-center rounded-xl text-left transition-colors duration-150 hover:bg-raised/50", SIMPLE_ROW_FOCUS,
        iconOnly ? "justify-center px-1 py-1.5" : simple ? "gap-2 rounded-[8px] px-2 py-2" : "gap-3 py-2 pl-2.5 pr-3", dim && "opacity-60")}>
      <span className="relative flex shrink-0">
        <BotAvatar bot={avatarOf(row)} state="idle" size={iconOnly || !simple ? 44 : 36} motion="none" animated={false} />
        {row.home === "cloud" && iconOnly && (
          <span className="absolute -bottom-0.5 -left-0.5 flex size-[18px] items-center justify-center rounded-full border-2 border-panel bg-panel"><CloudBotMark /></span>
        )}
        {(row.waiting || row.working) && <span aria-hidden="true" className={cn("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-panel", row.waiting ? "bg-warning" : "bg-success")} />}
      </span>
      {!iconOnly && (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span dir="auto" className={cn("truncate text-ink", simple ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5")}>{row.name}</span>
            {row.home === "cloud" && <CloudBotMark />}
          </span>
          {line && <span dir="auto" className={cn("truncate text-[13px] leading-[18px]", row.waiting ? "text-warning" : "text-ink-secondary")}>{line}</span>}
        </span>
      )}
      {!iconOnly && row.unread && <span aria-hidden="true" data-testid="unread-dot" className="size-2 shrink-0 rounded-full bg-accent" />}
    </button>
  );
}

/** Nothing unless main says the switch is on. */
export function OtherPlaceBots({ query = "" }: { query?: string }) {
  const together = usePlacesTogether();
  const density = useSidebarDensity();
  const simple = !useAdvancedMode();
  const [collapsed, setCollapsed] = useState(false);
  const other = together?.on ? together.other : null;
  if (!other) return null;
  const rows = matchingRows(other.bots, query);
  const said = stateLine(other.state, other.home);
  if (!rows.length && (query.trim() || !said)) return null;
  const iconOnly = density === "icons";
  const name = homeLabel(other.home);
  return (
    <div data-other-place={other.home} data-other-place-state={other.state} className={cn("flex flex-col gap-0.5", !iconOnly && "pt-3")}>
      {!iconOnly && <SidebarSectionHeader name={name} line={simple} collapsed={collapsed}
        onToggle={() => setCollapsed((was) => !was)} reorderable={false} dragging={false} />}
      {said && !iconOnly && <p role="status" data-other-place-line="" className="px-2 pb-1 text-[12px] leading-4 text-ink-secondary">{said}</p>}
      {!collapsed && rows.map((row) => <OtherPlaceBotRow key={placedKey(row.home, row.id)} row={row} dim={other.state !== "ready" && other.state !== "loading"} iconOnly={iconOnly} simple={simple} />)}
    </div>
  );
}
