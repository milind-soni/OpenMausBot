// Dev-only gallery of the usage meter, served at /usage-meter-preview.html; not in the packaged app.
// ?view=sidebar|settings|confirm&state=near|full|browser|top|trial&skin=midnight|daylight&lang=de
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Bot, CalendarClock, Gauge, LayoutGrid, MessageSquare, Plus, Search, Settings } from "lucide-react";
import type { CloudUsage } from "../electron/cloud-home.mjs";
import { InitialsAvatar } from "@/components/Avatar";
import { ConfirmDialogCard } from "@/components/ConfirmDialog";
import { CloudUsageCardView, CloudUsageSettingsView } from "@/components/CloudUsageMeter";
import { Card } from "@/components/SettingsPrimitives";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { setLocale, t } from "@/lib/i18n";
import { SKIN_IDS, type SkinId } from "@/lib/skins";
import { upgradeConfirmBody, usageCardView } from "@/lib/usage-meter";
import "./styles.css";

const RESETS = Date.UTC(2026, 10, 1);
const USAGE: Record<string, CloudUsage> = {
  near: { tier: "pro", resetsAt: RESETS, upgrades: [{ tier: "max", amount: 9900 }], meters: [
    { kind: "computerHours", used: 254.5, max: 300 }, { kind: "voice", used: 21_400, max: 60_000 }, { kind: "decisions", used: 6_120, max: 20_000 },
    { kind: "x", used: 17_300, max: 20_000 }, { kind: "research", used: 6.4, max: 15 }, { kind: "storage", used: 38.6, max: 100 }] },
  full: { tier: "starter", resetsAt: RESETS, upgrades: [{ tier: "pro", amount: 4900 }, { tier: "max", amount: 9900 }], meters: [
    { kind: "computerHours", used: 100, max: 100, usedUp: true }, { kind: "voice", used: 26_000, max: 30_000 }, { kind: "decisions", used: 1_900, max: 5_000 },
    { kind: "x", used: 1_200, max: 5_000 }, { kind: "storage", used: 12.1, max: 20 }] },
  browser: { tier: "pro", resetsAt: RESETS, upgrades: [], meters: [{ kind: "computerHours", used: 262, max: 300 }, { kind: "voice", used: 9_000, max: 60_000 }] },
  top: { tier: "max", resetsAt: RESETS, upgrades: [], meters: [{ kind: "computerHours", used: 690, max: 800 }, { kind: "voice", used: 40_000, max: 180_000 },
    { kind: "storage", used: 61.8, max: 100 }] },
  trial: { tier: "pro", resetsAt: RESETS, trialEndsAt: Date.UTC(2026, 9, 27), upgrades: [{ tier: "max", amount: 9900 }], meters: [
    { kind: "computerHours", used: 28.4, max: 30 }, { kind: "voice", used: 4_100, max: 6_000 }] },
};
const noop = () => {};

function SidebarMock({ usage }: { usage: CloudUsage }) {
  const view = usageCardView({ usage, teamHome: false, dismissed: null });
  const row = (Icon: typeof Bot, label: string, active = false) => <div key={label} className={`flex min-h-9 items-center gap-3 rounded-xl px-3 py-1.5 text-[14px] font-medium ${active ? "bg-raised text-ink" : "text-ink"}`}><Icon size={18} className="text-ink-secondary" />{label}</div>;
  return <div className="flex h-full bg-app text-ink">
    <aside className="flex w-[260px] shrink-0 flex-col border-e border-hairline/40 bg-panel">
      <div className="flex gap-[7px] px-3.5 pb-1.5 pt-3.5">{[0, 1, 2].map(dot => <i key={dot} className="block size-[11px] rounded-full bg-raised" />)}</div>
      <div className="mx-3 my-2 flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-[13px] text-ink-secondary"><Search size={15} />Search</div>
      <div className="px-3">{row(MessageSquare, "Chief", true)}{row(Bot, "Research")}{row(Bot, "Inbox")}{row(Plus, "New bot")}</div>
      <div className="flex-1" />
      <div className="px-3 pb-3 pt-2">
        {row(CalendarClock, "Routines")}{row(LayoutGrid, "Apps")}{row(Settings, "Settings")}
        <div className="mt-3">
          {view && <CloudUsageCardView usage={usage} meters={view.meters} band={view.band} upgrade={{ busy: null, note: null, onUpgrade: noop }} onHide={noop} onSeeAll={noop} />}
        </div>
        <div className="flex min-h-[46px] items-center gap-3 rounded-xl px-3 py-2"><InitialsAvatar initials="MS" size={28} /><span className="truncate text-[14px] font-medium">Maya Shah</span></div>
      </div>
    </aside>
    <main className="flex flex-1 flex-col gap-3.5 p-10 opacity-60">
      {[58, 44, 36, 62, 30].map((width, index) => <div key={index} className={`h-3.5 rounded-md ${index === 2 ? "self-end bg-raised" : "bg-card"}`} style={{ width: `${width}%` }} />)}
    </main>
  </div>;
}

function SettingsMock({ usage }: { usage: CloudUsage }) {
  return <div className="flex h-full justify-center bg-black/40 p-8">
    <div className="flex w-full max-w-[920px] overflow-hidden rounded-2xl border border-hairline/40 bg-panel text-ink shadow-2xl">
      <nav className="w-[220px] shrink-0 border-e border-hairline/40 p-3 text-[14px]">
        {["General", "Appearance", "MausBot Cloud", "AI & keys", "Usage", "Apps"].map((label, index) => <div key={label} className={`rounded-lg px-3 py-2 ${index === 0 ? "bg-raised font-medium" : "text-ink-secondary"}`}>{label}</div>)}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <h1 className="text-[20px] font-semibold">General</h1>
        <section className="flex items-center justify-between gap-3 rounded-xl border border-hairline/50 p-3">
          <div className="flex items-center gap-3"><Gauge size={18} className="text-ink-secondary" /><div><h3 className="text-[14px] font-semibold">MausBot Cloud</h3>
            <p className="mt-1 text-[12px] text-ink-secondary">{t("cloudAccount.pro", { plan: cloudPlanLabel(usage.tier) })}</p></div></div>
          <span className="ui-button">{t("pro.openCloudSettings")}</span>
        </section>
        <CloudUsageSettingsView usage={usage} upgrade={{ busy: null, note: null, onUpgrade: noop }} />
        <Card title={t("settings.profile.title")} subtitle={t("settings.profile.sharedSubtitle")} />
      </div>
    </div>
  </div>;
}

function ConfirmMock({ usage }: { usage: CloudUsage }) {
  const plan = usage.upgrades[0]?.tier ?? "max", price = usage.upgrades[0]?.amount ?? 9900;
  const preview = { plan, trial: Boolean(usage.trialEndsAt), price, chargeNow: usage.trialEndsAt ? 0 : 2340, tax: 0, nextBillingAt: usage.trialEndsAt ?? Date.UTC(2026, 10, 18) };
  return <div className="relative h-full">
    <SidebarMock usage={usage} />
    <div className="absolute inset-0 flex items-center justify-center bg-black/55 p-6">
      <ConfirmDialogCard open tone="neutral" icon={<Gauge size={18} className="text-accent" />} title={t("usageMeter.confirm.title", { plan: cloudPlanLabel(plan) })}
        body={upgradeConfirmBody(preview)} confirmLabel={t("usageMeter.confirm.action", { plan: cloudPlanLabel(plan) })} cancelLabel={t("usageMeter.confirm.cancel")}
        onCancel={noop} onConfirm={noop} />
    </div>
  </div>;
}

function Preview() {
  const params = new URLSearchParams(location.search);
  const skin = (SKIN_IDS as readonly string[]).includes(params.get("skin") ?? "") ? params.get("skin") as SkinId : "midnight";
  document.documentElement.dataset.skin = skin;
  setLocale(params.get("lang") ?? "en");
  const usage = USAGE[params.get("state") ?? "near"] ?? USAGE.near!;
  const view = params.get("view") ?? "sidebar";
  return <div className="h-screen overflow-hidden">
    {view === "settings" ? <SettingsMock usage={usage} /> : view === "confirm" ? <ConfirmMock usage={usage} /> : <SidebarMock usage={usage} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
