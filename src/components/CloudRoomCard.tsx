import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";

import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { usageBridge, useUpgrade, NoteLine, type UpgradeUi } from "./CloudUsageMeter";
import { useCloudPlanSnapshot } from "./CloudTrialNotice";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { readRoomCardHidden, rememberRoomCardHidden, roomCardView, type RoomCardView } from "@/lib/room-card";
import { readUsageCardDismissed, upgradePath, usageCardView } from "@/lib/usage-meter";
import { useStore } from "@/state/store";

type Restart = "asking" | "restarting" | "current" | "failed";
const RESTART_NOTE: Record<Exclude<Restart, "asking">, string> = {
  restarting: "roomCard.restarting", current: "roomCard.current", failed: "roomCard.restartFailed",
} as const;

/** The card as it looks: the cause, the plan that fixes it with its price (or a tip on the top plan), Upgrade and Not now;
 * after an upgrade, Restart now. */
export function CloudRoomCardView({ view, upgrade, browser, upgraded, restart, onNotNow, onRestart, children }: {
  view: RoomCardView | null; upgrade: UpgradeUi; browser: boolean; upgraded: string | null; restart: Restart | null;
  onNotNow: () => void; onRestart: () => void; children?: ReactNode;
}) {
  if (upgraded) {
    return (
      <section data-cloud-room-card="upgraded" className="mb-2 rounded-xl border border-hairline/50 bg-card p-3 text-ink shadow-sm">
        <p role="status" className="text-[12px] leading-relaxed text-ink">{restart && restart !== "asking" ? t(RESTART_NOTE[restart] as Parameters<typeof t>[0]) : t("roomCard.done", { plan: cloudPlanLabel(upgraded) })}</p>
        {(restart === null || restart === "asking") && <>
          <button type="button" className="ui-button mt-2.5 w-full justify-center gap-1.5" disabled={restart === "asking"} onClick={onRestart}>
            {restart === "asking" && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {t("roomCard.restartNow")}
          </button>
          <p className="mt-1.5 text-center text-[11px] leading-4 text-ink-secondary">{t("roomCard.restartHint")}</p>
        </>}
        {children}
      </section>
    );
  }
  if (!view) return <>{children}</>;
  return (
    <section aria-labelledby="cloud-room-card-title" data-cloud-room-card={view.offer ? "upgrade" : "tip"} data-room-cause={view.kind}
      className="mb-2 rounded-xl border border-hairline/50 bg-card p-3 text-ink shadow-sm">
      <h2 id="cloud-room-card-title" className="text-[13px] font-semibold leading-5">{view.title}</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-ink">{view.cause}</p>
      {view.offer ? <>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{view.offer.text} {view.offer.price}</p>
        <div className="mt-2.5 flex items-center gap-2">
          <button type="button" className="ui-button ui-button-primary min-w-0 flex-1 justify-center gap-1.5" disabled={upgrade.busy !== null} onClick={() => upgrade.onUpgrade(view.offer!.tier)}>
            {upgrade.busy === "preview" && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {t("roomCard.upgrade")}
            {browser && <ArrowUpRight size={13} aria-hidden="true" />}
          </button>
          <button type="button" className="ui-button min-w-0 flex-1 justify-center" disabled={upgrade.busy !== null} onClick={onNotNow}>{t("roomCard.notNow")}</button>
        </div>
      </> : <>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{view.tip}</p>
        <button type="button" className="ui-button mt-2.5 w-full justify-center" onClick={onNotNow}>{t("roomCard.gotIt")}</button>
      </>}
      {upgrade.note && <div className="mt-2"><NoteLine note={upgrade.note} /></div>}
      {children}
    </section>
  );
}

/** The plan's snapshot as the room card reads it, with the bridge that acts on it. */
export function useCloudRoom(): { snapshot: CloudPlanSnapshot | null; bridge: CloudPlanBridge | undefined; teamHome: boolean } {
  const { state } = useStore();
  const bridge = usageBridge(state.config?.cloudHome === true);
  return { snapshot: useCloudPlanSnapshot(bridge), bridge, teamHome: Boolean(state.config?.cloudHome && state.config?.team) };
}

/**
 * Where the usage meter's card is (the sidebar's foot, the phone's bar): this Cloud is short on room, said once, calmly. Its
 * Upgrade is the usual one (its preview, then the person's confirmation); Not now holds it back (the Admin, for two weeks).
 */
export function CloudRoomCard() {
  const { state } = useStore();
  const { snapshot, bridge, teamHome } = useCloudRoom();
  const usage = snapshot?.status === "paid" ? snapshot.usage ?? null : null;
  const [hidden, setHidden] = useState(readRoomCardHidden);
  const [upgraded, setUpgraded] = useState<string | null>(null);
  const [restart, setRestart] = useState<Restart | null>(null);
  const upgrade = useUpgrade(bridge, usage, "app_room", setUpgraded);
  // Restart now acts on the session's own Cloud: once that session ends, an upgrade made in it is no longer this card's.
  const paid = snapshot?.status === "paid";
  useEffect(() => { if (!paid) { setUpgraded(null); setRestart(null); } }, [paid]);
  const view = roomCardView({ room: snapshot?.status === "paid" ? snapshot.room : null, usage, busy: state.bots.some((bot) => bot.busy), hidden, teamHome,
    usageCardShown: Boolean(usageCardView({ usage, teamHome, dismissed: readUsageCardDismissed() })) });
  const notNow = () => {
    if (!view) return;
    rememberRoomCardHidden(view.id);
    setHidden(view.id);
    void bridge?.roomNotNow?.(view.id).catch(() => false);
  };
  const restartNow = () => {
    if (!bridge?.restartNow) { setRestart("failed"); return; }
    setRestart("asking");
    void bridge.restartNow().then(setRestart, () => setRestart("failed"));
  };
  return (
    <CloudRoomCardView view={view} upgrade={{ busy: upgrade.busy, note: upgrade.note, onUpgrade: upgrade.start }} browser={Boolean(usage) && upgradePath(usage!) === "browser"}
      upgraded={upgraded} restart={restart} onNotNow={notNow} onRestart={restartNow}>
      {upgrade.dialog}
    </CloudRoomCardView>
  );
}
