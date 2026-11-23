import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PlanUsageBandView, type PlanUsageBandLine } from "@/components/PlanUsageBand";
import { loadLocale } from "@/lib/i18n";
import { SKIN_IDS, type SkinId } from "@/lib/skins";
import "./styles.css";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

const NEAR: PlanUsageBandLine[] = [
  { label: "5-hour", percent: 38, resetsAt: new Date(now + 2 * HOUR).toISOString() },
  { label: "Weekly", percent: 72, resetsAt: new Date(now + 3 * DAY).toISOString() },
];
const FULL: PlanUsageBandLine[] = [
  { label: "5-hour", percent: 100, resetsAt: new Date(now + 45 * 60_000).toISOString() },
  { label: "Weekly", percent: 88, resetsAt: new Date(now + 3 * DAY).toISOString() },
];
const MONTHLY: PlanUsageBandLine[] = [...NEAR, { label: "Monthly", percent: 61, resetsAt: null }];

function Preview() {
  const params = new URLSearchParams(location.search);
  const skin = (SKIN_IDS as readonly string[]).includes(params.get("skin") ?? "") ? params.get("skin") as SkinId : "midnight";
  document.documentElement.dataset.skin = skin;
  const state = params.get("state") ?? "near";
  const lines = state === "full" ? FULL : state === "monthly" ? MONTHLY : NEAR;
  return (
    <div className="flex min-h-screen flex-col justify-end bg-app px-4 pb-6 text-ink">
      <div className="mx-auto w-full max-w-3xl">
        {state !== "none" && <PlanUsageBandView lines={lines} now={now} />}
        <div className="flex min-h-[52px] items-center rounded-2xl border border-hairline bg-composer px-4 text-[15px] text-ink-tertiary">
          Message Chief of Staff…
        </div>
      </div>
    </div>
  );
}

await loadLocale(new URLSearchParams(location.search).get("lang") ?? "en");
createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
