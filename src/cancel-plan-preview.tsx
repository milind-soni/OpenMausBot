// Dev-only gallery of Cancel trial / Cancel plan, served at /cancel-plan-preview.html; not in the packaged app.
// ?view=settings|cloud&plan=trial|paid|team&cancelled=1&admin=old&skin=midnight|daylight&lang=de
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { CloudAccountBridge, CloudAccountState, CloudPlanBridge, CloudPlanSnapshot, CloudRenewalResult } from "../electron/cloud-account.mjs";
import type { CloudRenewal } from "../electron/cloud-list.mjs";
import { CloudAccountSettings, CloudPlanOnCloud } from "@/components/CloudAccountSettings";
import { setLocale } from "@/lib/i18n";
import { SKIN_IDS, type SkinId } from "@/lib/skins";
import "./styles.css";

const DAY = 86_400_000, ENDS = Date.UTC(2026, 10, 4, 12);
const params = new URLSearchParams(location.search);
const kind = params.get("plan") === "paid" ? "paid" : params.get("plan") === "team" ? "team" : "trial";
let renewal: CloudRenewal = { trial: kind === "trial", cancelled: false, renewsAt: ENDS, endsAt: null, keptDays: kind === "trial" ? 3 : 1, ...(kind === "team" ? { team: "Acme" } : {}) };
if (params.get("cancelled") === "1") renewal = { ...renewal, cancelled: true, renewsAt: null, endsAt: ENDS };
const state = (): CloudAccountState => ({ status: "connected", account: { id: "preview", email: "maya@example.test" },
  entitlement: { plan: "pro", tier: kind === "team" ? "team" : "pro", status: "active", expiresAt: ENDS + 30 * DAY, version: 1 }, verifiedAt: Date.now(), verifiedUntil: Date.now() + DAY,
  ...(kind === "trial" ? { trial: { state: renewal.cancelled ? "ending" : "active", tier: "pro", endsAt: ENDS, amount: 4900, chargeAt: ENDS, holdUntil: null, deleteAt: renewal.cancelled ? ENDS + 3 * DAY : null,
    keep: renewal.cancelled ? "portal" : "none" } } : {}), renewal });
const listeners = new Set<(next: CloudAccountState) => void>();
const settle = (next: CloudRenewal) => { renewal = next; listeners.forEach(listener => listener(state())); };
const wait = () => new Promise(resolve => setTimeout(resolve, 400));
/** As main answers: the Admin turns renewal off or on; an older Admin (`admin=old`) opens the Cloud page's billing instead. */
const cancel = async (): Promise<CloudRenewalResult> => {
  await wait();
  if (params.get("admin") === "old") return { outcome: "browser" };
  const next = { ...renewal, cancelled: true, renewsAt: null, endsAt: ENDS };
  settle(next);
  return { outcome: "cancelled", renewal: next, surveyed: true, state: state() };
};
const keep = async (): Promise<CloudRenewalResult> => { await wait(); settle({ ...renewal, cancelled: false, renewsAt: ENDS, endsAt: null }); return { outcome: "kept", state: state() }; };
const account = { state: async () => state(), begin: async () => state(), signInAgain: async () => state(), reopen: async () => state(), cancel: async () => state(),
  refresh: async () => state(), signOut: async () => state(), openDashboard: async () => state(), connectHome: async () => state(), connectHomeForPhone: async () => state(),
  onState: (listener: (next: CloudAccountState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, cancelPlan: cancel, keepPlan: keep } satisfies CloudAccountBridge;
const plan = { state: async (): Promise<CloudPlanSnapshot> => ({ status: "paid", tier: "pro", home: true, ...(kind === "trial" ? { trial: state().trial } : {}), renewal }),
  manage: async () => undefined, cancel, keep } satisfies CloudPlanBridge;

function Preview() {
  const skin = (SKIN_IDS as readonly string[]).includes(params.get("skin") ?? "") ? params.get("skin") as SkinId : "midnight";
  document.documentElement.dataset.skin = skin;
  setLocale(params.get("lang") ?? "en");
  const cloudPage = params.get("view") === "cloud";
  return <div className="flex min-h-screen justify-center bg-app p-6 text-ink sm:p-10">
    <div className="flex w-full max-w-[680px] flex-col gap-4">
      <h1 className="text-[20px] font-semibold">{cloudPage ? "Settings · on the Cloud" : "Settings · Usage & billing"}</h1>
      {cloudPage ? <CloudPlanOnCloud bridge={plan} /> : <CloudAccountSettings />}
    </div>
  </div>;
}

window.ogb = { ...window.ogb, cloudAccount: account } as typeof window.ogb;
createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
