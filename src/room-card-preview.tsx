// Dev-only gallery of the room card, served at /room-card-preview.html; not in the packaged app.
// ?state=memory|stopped|disk|tip|trial|upgraded|restarting|confirm&layout=desktop|phone&skin=midnight|daylight&lang=de
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Bot, CalendarClock, Gauge, LayoutGrid, MessageSquare, Plus, Search, Settings } from "lucide-react";
import type { CloudRoom, CloudUsage } from "../electron/cloud-home.mjs";
import { InitialsAvatar } from "@/components/Avatar";
import { ConfirmDialogCard } from "@/components/ConfirmDialog";
import { CloudRoomCardView } from "@/components/CloudRoomCard";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { setLocale, t } from "@/lib/i18n";
import { roomCardView } from "@/lib/room-card";
import { SKIN_IDS, type SkinId } from "@/lib/skins";
import { upgradeConfirmBody } from "@/lib/usage-meter";
import "./styles.css";

const RESETS = Date.UTC(2026, 10, 1);
const STARTER: CloudUsage = { tier: "starter", resetsAt: RESETS, meters: [], upgrades: [{ tier: "pro", amount: 4900 }, { tier: "max", amount: 9900 }] };
const PRO_PLAN = { tier: "pro" as const, amount: 4900, memoryMb: 4096, fromMemoryMb: 2048, diskGb: 100, fromDiskGb: 10 };
const STATES: Record<string, { usage: CloudUsage; room: CloudRoom }> = {
  memory: { usage: STARTER, room: { id: "a", cause: { kind: "memory", waits: 3, waitMinutes: 6, stopped: 0 }, plan: PRO_PLAN } },
  stopped: { usage: STARTER, room: { id: "b", cause: { kind: "memory", waits: 2, waitMinutes: 4, stopped: 1 }, plan: PRO_PLAN } },
  disk: { usage: STARTER, room: { id: "c", cause: { kind: "disk", usedGb: 8.9, capGb: 10 }, plan: PRO_PLAN } },
  tip: { usage: { tier: "max", resetsAt: RESETS, meters: [], upgrades: [] }, room: { id: "d", cause: { kind: "memory", waits: 5, waitMinutes: 14, stopped: 2 }, tip: true } },
  trial: { usage: { ...STARTER, trialEndsAt: Date.UTC(2026, 10, 3) }, room: { id: "e", cause: { kind: "memory", waits: 4, waitMinutes: 9, stopped: 0 }, plan: PRO_PLAN } },
};
const noop = () => {};
const IDLE = { busy: null, note: null, onUpgrade: noop };

function Card({ state }: { state: string }) {
  const sample = STATES[state] ?? STATES.memory!;
  if (state === "upgraded" || state === "restarting") {
    return <CloudRoomCardView view={null} upgrade={IDLE} browser={false} upgraded="pro" restart={state === "restarting" ? "restarting" : null} onNotNow={noop} onRestart={noop} />;
  }
  const view = roomCardView({ room: sample.room, usage: sample.usage, busy: false, hidden: null, usageCardShown: false });
  return <CloudRoomCardView view={view} upgrade={IDLE} browser={false} upgraded={null} restart={null} onNotNow={noop} onRestart={noop} />;
}

function row(Icon: typeof Bot, label: string, active = false) {
  return <div key={label} className={`flex min-h-9 items-center gap-3 rounded-xl px-3 py-1.5 text-[14px] font-medium ${active ? "bg-raised text-ink" : "text-ink"}`}><Icon size={18} className="text-ink-secondary" />{label}</div>;
}

function Desktop({ state }: { state: string }) {
  return <div className="flex h-full bg-app text-ink">
    <aside className="flex w-[260px] shrink-0 flex-col border-e border-hairline/40 bg-panel">
      <div className="flex gap-[7px] px-3.5 pb-1.5 pt-3.5">{[0, 1, 2].map(dot => <i key={dot} className="block size-[11px] rounded-full bg-raised" />)}</div>
      <div className="mx-3 my-2 flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-[13px] text-ink-secondary"><Search size={15} />Search</div>
      <div className="px-3">{row(MessageSquare, "Chief", true)}{row(Bot, "Research")}{row(Bot, "Inbox")}{row(Plus, "New bot")}</div>
      <div className="flex-1" />
      <div className="px-3 pb-3 pt-2">
        {row(CalendarClock, "Routines")}{row(LayoutGrid, "Apps")}{row(Settings, "Settings")}
        <div className="mt-3"><Card state={state} /></div>
        <div className="flex min-h-[46px] items-center gap-3 rounded-xl px-3 py-2"><InitialsAvatar initials="MS" size={28} /><span className="truncate text-[14px] font-medium">Maya Shah</span></div>
      </div>
    </aside>
    <main className="flex flex-1 flex-col gap-3.5 p-10 opacity-60">
      {[58, 44, 36, 62, 30].map((width, index) => <div key={index} className={`h-3.5 rounded-md ${index === 2 ? "self-end bg-raised" : "bg-card"}`} style={{ width: `${width}%` }} />)}
    </main>
  </div>;
}

function Phone({ state }: { state: string }) {
  return <div className="flex h-full flex-col bg-panel text-ink">
    <div className="px-4 pb-2 pt-5 text-[22px] font-semibold">Chats</div>
    <div className="flex-1 px-3">{row(MessageSquare, "Chief", true)}{row(Bot, "Research")}{row(Bot, "Inbox")}{row(Bot, "Travel")}{row(Plus, "New bot")}</div>
    <div className="px-3 pb-3 pt-1">
      <Card state={state} />
      <div className="flex items-center gap-2 not-first:mt-2">
        <span className="flex size-11 items-center justify-center rounded-full border border-hairline bg-card text-ink"><LayoutGrid size={19} aria-hidden="true" /></span>
        <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-hairline bg-card pl-3.5 pr-1.5 text-ink-secondary"><Search size={17} aria-hidden="true" />Search</div>
      </div>
    </div>
  </div>;
}

function Confirm({ layout }: { layout: string }) {
  const preview = { plan: "pro", trial: false, price: 4900, chargeNow: 3120, tax: 0, nextBillingAt: Date.UTC(2026, 10, 18) };
  return <div className="relative h-full">
    {layout === "phone" ? <Phone state="memory" /> : <Desktop state="memory" />}
    <div className="absolute inset-0 flex items-center justify-center bg-black/55 p-6">
      <ConfirmDialogCard open tone="neutral" icon={<Gauge size={18} className="text-accent" />} title={t("usageMeter.confirm.title", { plan: cloudPlanLabel("pro") })}
        body={upgradeConfirmBody(preview)} confirmLabel={t("usageMeter.confirm.action", { plan: cloudPlanLabel("pro") })} cancelLabel={t("usageMeter.confirm.cancel")}
        onCancel={noop} onConfirm={noop} />
    </div>
  </div>;
}

function Preview() {
  const params = new URLSearchParams(location.search);
  const skin = (SKIN_IDS as readonly string[]).includes(params.get("skin") ?? "") ? params.get("skin") as SkinId : "midnight";
  document.documentElement.dataset.skin = skin;
  setLocale(params.get("lang") ?? "en");
  const state = params.get("state") ?? "memory", layout = params.get("layout") ?? "desktop";
  return <div className="h-screen overflow-hidden">
    {state === "confirm" ? <Confirm layout={layout} /> : layout === "phone" ? <Phone state={state} /> : <Desktop state={state} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
