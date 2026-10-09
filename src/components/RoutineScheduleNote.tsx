// Where a routine runs, said where it is scheduled (docs/cloud-pro.md, "Add a
// Cloud"): on this computer only while the app is open, so 24/7 means My
// Cloud. One note per place, each with at most one way on:
// - This computer, no Cloud: Add a Cloud (the dialog, over the routine being
//   edited, which stays as it is);
// - This computer, with a Cloud: Open My Cloud, to create them there (which
//   leaves this page, so it asks first: the routine being edited isn't saved);
// - My Cloud itself: it runs 24/7;
// - another server, a browser or companion mode: while that server runs.
import { brandStatus } from "@/lib/brand";
import { buyOfferAllowed, type CloudPlanView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { useCloudPlan } from "./ProIntroduction";

export type SchedulePlace = { kind: "cloud" } | { kind: "server" } | { kind: "local"; next: "add-cloud" | "open-cloud" | null };

/** Which note fits: My Cloud's own page, This computer's (with its way on,
 * from the plan: a ready My Cloud to open, or a Cloud to add for someone who
 * may buy where Cloud is offered), or any other server. */
export function schedulePlace({ cloudHome, local, plan, ready, offersAllowed }: {
  cloudHome: boolean; local: boolean; plan: CloudPlanView | null; ready: boolean; offersAllowed: boolean;
}): SchedulePlace {
  if (cloudHome) return { kind: "cloud" };
  if (!local) return { kind: "server" };
  if (plan?.kind === "paid") return { kind: "local", next: ready ? "open-cloud" : null };
  return { kind: "local", next: plan && offersAllowed && buyOfferAllowed(plan) ? "add-cloud" : null };
}

export function RoutineScheduleNote() {
  const { state, dispatch } = useStore();
  const plan = useCloudPlan();
  const local = localDesktopPage() && window.ogb?.remoteClient?.active !== true;
  const place = schedulePlace({ cloudHome: state.config?.cloudHome === true, local, plan: plan?.view ?? null,
    ready: plan?.account?.machine?.status === "ready", offersAllowed: brandStatus().source !== "file" });
  const link = "text-left underline underline-offset-2 hover:text-ink";
  // Opening My Cloud switches this window there: the routine being edited here would close unsaved.
  const openCloud = () => { if (window.confirm(t("routines.scheduleNote.leave"))) void window.ogb?.cloudAccount?.connectHome().catch(() => {}); };
  return <p data-routine-schedule-note={place.kind === "local" ? place.next ?? "local" : place.kind} className="text-[11px] leading-relaxed text-ink-secondary">
    {place.kind === "cloud" ? t("routines.scheduleNote.cloud") : place.kind === "server" ? t("routines.scheduleNote.server") : <>
      {t("routines.scheduleNote.local")}
      {place.next === "add-cloud" && <> <button type="button" className={link} onClick={() => dispatch({ type: "openCloudAdd", source: "app_routines" })}>{t("routines.scheduleNote.addCloud")}</button></>}
      {place.next === "open-cloud" && <> {t("routines.scheduleNote.openCloud")} <button type="button" className={link} onClick={openCloud}>{t("cloudHome.connect")}</button></>}
    </>}
  </p>;
}
