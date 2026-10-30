// Dev-only gallery of the Cloud buying sheet and the Cloud Pro popup, served at /cloud-buy-preview.html; not in the packaged app.
// ?state=choose|choose-plain|sign-in-email|sign-in-code|sign-in-wrong|sign-in-sso|sign-in-done|sign-in-browser|pay|pay-late|setup|setup-slow|ready|has-cloud
//   |team-setup|team-ready|unreachable|pro-popup|pro-popup-plain|pro-popup-plan|pro-popup-reauth
// &skin=midnight&staging=1&reduced=1&plan=starter&lang=de
// &current=pro (a subscriber's own plan says Your plan; current=personal shows a Personal subscriber's own card)
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Cloud, FolderOpen, MessageSquare, Repeat } from "lucide-react";
import type { CloudAccountState } from "../electron/cloud-account.mjs";
import type { CloudOffer } from "../electron/cloud-home.mjs";
import { CloudAddPanel, CloudAddSheet, type CloudAddActions, type CloudAddUi } from "@/components/CloudAddDialog";
import { CloudProPopup, cloudProPopupView } from "@/components/CloudProPopup";
import { ChooseScreen } from "@/components/cloud-buy/ChooseScreen";
import type { CloudAddView } from "@/lib/cloud-plan";
import { setLocale } from "@/lib/i18n";
import { SKIN_IDS, type SkinId } from "@/lib/skins";
import "./styles.css";

const NOW = Date.now(), DAY = 86_400_000;
const allowances = (cpus: number, swapGb: number, maxDiskGb: number, computers: number, computerHours: number, voiceCharacters: number, snapshotDays: number) =>
  ({ cpus, cpuKind: "shared" as const, memoryMb: cpus * 1024, ...(swapGb ? { swapMb: swapGb * 1024 } : {}), diskGb: 10, maxDiskGb, computers, computerHours, voiceCharacters, snapshotDays });
const OFFER: CloudOffer = { recommended: "pro", creditUsd: 5, reminderDays: 1, refundDays: 14, plans: [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 3, allowances: allowances(2, 3, 20, 15, 100, 30_000, 14) },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 3, allowances: allowances(4, 4, 100, 15, 300, 60_000, 14) },
  { tier: "max", label: "Max", amount: 9900, trialDays: 3, allowances: allowances(8, 4, 100, 15, 800, 180_000, 14) },
] };
const PLAIN: CloudOffer = { recommended: "pro", refundDays: 14, plans: OFFER.plans.map(({ trialDays: _days, ...plan }) => plan) };
const PERSONAL = { tier: "personal", label: "Personal", amount: 2900, allowances: allowances(2, 3, 20, 15, 100, 30_000, 14) };
const started = { tier: "pro", trial: { state: "active" as const, tier: "pro", endsAt: NOW + 3 * DAY, amount: 4900, chargeAt: NOW + 3 * DAY, holdUntil: null, deleteAt: null, keep: "none" as const },
  credit: { grantedUsd: 5, remainingUsd: 5, state: "active" as const } };
const VIEWS: Record<string, CloudAddView> = {
  choose: { kind: "offer", offer: OFFER, signedOut: true, notice: null },
  "choose-plain": { kind: "offer", offer: PLAIN, signedOut: false, notice: null },
  "sign-in-email": { kind: "sign-in", phase: { step: "email", intent: true, problem: null } },
  "sign-in-code": { kind: "sign-in", phase: { step: "code", intent: true, email: "maya@studio.co", resendAt: NOW + 21_000, problem: null, triesLeft: null } },
  "sign-in-wrong": { kind: "sign-in", phase: { step: "code", intent: true, email: "maya@studio.co", resendAt: NOW - 1, problem: "wrong-code", triesLeft: 3 } },
  "sign-in-sso": { kind: "sign-in", phase: { step: "email", intent: true, problem: "sso" } },
  "sign-in-done": { kind: "sign-in", phase: { step: "done", intent: true } },
  "sign-in-browser": { kind: "signing-in", code: "KQWX-7RTM", checkout: true },
  pay: { kind: "waiting", plan: "pro", browser: "checkout", late: false, link: true, email: "maya@studio.co" },
  "pay-late": { kind: "waiting", plan: "pro", browser: "checkout", late: true, link: true, email: "maya@studio.co" },
  setup: { kind: "starting", ...started, step: "storage", slow: false, received: false },
  "setup-slow": { kind: "starting", ...started, step: "starting", slow: true, received: false },
  ready: { kind: "ready", ...started },
  "has-cloud": { kind: "has-cloud" },
  "team-setup": { kind: "team-starting", team: "Acme", step: "storage", slow: false },
  "team-ready": { kind: "team-ready", team: { id: "team-acme", name: "Acme" } },
  unreachable: { kind: "unreachable" },
};
const FREE: CloudAccountState = { status: "connected", account: { id: "a", email: "maya@studio.co" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const POPUPS: Record<string, { account: CloudAccountState; offer: CloudOffer }> = {
  "pro-popup": { account: { status: "signed-out" }, offer: OFFER },
  "pro-popup-plain": { account: FREE, offer: PLAIN },
  "pro-popup-plan": { account: { ...FREE, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 } }, offer: OFFER },
  "pro-popup-reauth": { account: { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }, offer: OFFER },
};
const noop = () => {};
const actions = new Proxy({}, { get: () => noop }) as CloudAddActions;

function MockApp() {
  return <div className="flex h-full bg-app text-ink">
    <aside className="flex w-[236px] shrink-0 flex-col border-e border-hairline/40 bg-panel">
      <div className="flex gap-[7px] px-3.5 pb-1.5 pt-3.5">{[0, 1, 2].map(dot => <i key={dot} className="block size-[11px] rounded-full bg-raised" />)}</div>
      <div className="mx-2.5 my-2 flex items-center gap-2 rounded-lg px-2 py-2 text-[13px] font-medium"><Cloud size={16} className="text-ink-secondary" />This computer</div>
      {[[MessageSquare, "Chats"], [Repeat, "Routines"], [FolderOpen, "Files"]].map(([Icon, label]) => {
        const Glyph = Icon as typeof Cloud;
        return <div key={label as string} className="mx-2.5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary"><Glyph size={15} />{label as string}</div>;
      })}
    </aside>
    <main className="flex flex-1 flex-col gap-3.5 p-10 opacity-60">
      {[58, 44, 36, 62, 30].map((width, index) => <div key={index} className={`h-3.5 rounded-md ${index === 2 ? "self-end bg-raised" : "bg-card"}`} style={{ width: `${width}%` }} />)}
    </main>
  </div>;
}

function Preview() {
  const params = new URLSearchParams(location.search);
  const skin = (SKIN_IDS as readonly string[]).includes(params.get("skin") ?? "") ? params.get("skin") as SkinId : "midnight";
  document.documentElement.dataset.skin = skin;
  if (params.get("reduced") === "1") document.documentElement.dataset.reducedMotion = "true";
  setLocale(params.get("lang") ?? "en");
  const state = params.get("state") ?? "choose";
  const asked = POPUPS[state], popup = asked ? cloudProPopupView(asked.account, asked.offer) : null;
  if (popup && typeof popup === "object") {
    return <div className="relative h-screen overflow-hidden">
      <MockApp />
      <CloudProPopup view={popup} onPrimary={noop} onSeePlans={noop} onNotNow={noop} onClose={noop} />
    </div>;
  }
  const view = VIEWS[state] ?? VIEWS.choose!;
  const current = params.get("current");
  const ui: CloudAddUi = { chosen: params.get("plan"), current, offerShown: view.kind === "offer" ? view.offer : OFFER, now: NOW, busy: state === "sign-in-done", openFailed: false,
    email: "maya@studio.co", code: state === "sign-in-code" ? "4820" : "", profileEmail: "maya@studio.co",
    look: { typed: "My Cloud", name: "My Cloud", color: "blue" }, counting: state === "ready" ? 3 : null, copied: false, payFailed: false, interest: null };
  return <div className="relative h-screen overflow-hidden">
    <MockApp />
    <CloudAddSheet kind={view.kind} staging={params.get("staging") === "1"} onClose={noop}>
      {current === "personal" && view.kind === "offer"
        ? <ChooseScreen offer={view.offer} current={current} own={PERSONAL} now={NOW} busy={false} signedOut={false} notice={null} onStart={noop} onSignIn={noop} />
        : <CloudAddPanel view={view} ui={ui} actions={actions} />}
    </CloudAddSheet>
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
