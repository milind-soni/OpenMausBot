import { cloudPlanSnapshot, UPGRADE_SOURCES } from "./cloud-account.mjs";
import { createSupportOutbox, supportBody } from "./support-request.mjs";

/** Another Cloud of the person's own, as its page may see its plan: its tier and whether it runs, from the session's list. */
export function otherCloudSnapshot(cloud) {
  const runs = ["ready", "setting_up", "offline"].includes(cloud.status);
  return { status: runs ? "paid" : "attention", ...(cloud.tier ? { tier: cloud.tier } : {}) };
}

// Security: an upgrade goes only to a plan the verified session lists, and only with the confirmation main kept from its
// own preview; a page never holds it. Upgrading is My Cloud's alone: another Cloud of the person's (`otherCloud(event)`,
// its page) reads its own plan, never My Cloud's.
export function installCloudPlanIpc({ ipcMain, pageSender, account, client, notices, homePage, otherCloud = () => null, support = null }) {
  // Contact support's outbox starts with main, so a message saved last time goes on its own schedule.
  const outbox = support ? createSupportOutbox({ store: support.store, send: body => client().supportRequest(body), account: () => account()?.state()?.account?.id ?? null, log: support.log }) : null;
  ipcMain.handle("cloud-plan:state", event => {
    const other = otherCloud(event);
    // Contact support follows the account signed in here, whichever of its Clouds the page is.
    if (other) return { ...otherCloudSnapshot(other), ...(({ support } = cloudPlanSnapshot(account()?.state())) => (support ? { support } : {}))(), ...(homePage(event) ? { home: true } : {}) };
    return pageSender("cloud-plan:state", () => {
      const state = account()?.state();
      return { ...cloudPlanSnapshot(state, { notice: notices().due(state) }), ...(homePage(event) ? { home: true } : {}) };
    })(event);
  });
  ipcMain.handle("cloud-plan:notice-seen", pageSender("cloud-plan:notice-seen", () => { notices().seen(account()?.state()); }));
  ipcMain.handle("cloud-plan:manage", event => (otherCloud(event) ? client().openDashboard().then(() => {}) : pageSender("cloud-plan:manage", async () => { await client().openDashboard(); })(event)));
  const upgradeArgs = (plan, source) => {
    const offered = client().state().usage?.upgrades ?? [];
    if (typeof plan !== "string" || !UPGRADE_SOURCES.includes(source) || !offered.some(entry => entry.tier === plan)) throw new Error("Choose a plan to move to.");
    return [plan, source];
  };
  ipcMain.handle("cloud-plan:upgrade-preview", (event, plan, source) => pageSender("cloud-plan:upgrade-preview", () => client().upgradePreview(...upgradeArgs(plan, source)))(event));
  ipcMain.handle("cloud-plan:upgrade", (event, plan, source) => pageSender("cloud-plan:upgrade", () => client().upgrade(...upgradeArgs(plan, source)))(event));
  // Cancel trial / Cancel plan and Keep my plan: the page's survey is checked in main, and the Cloud is the session's own.
  ipcMain.handle("cloud-plan:cancel", (event, survey) => pageSender("cloud-plan:cancel", () => client().cancelPlan(survey))(event));
  ipcMain.handle("cloud-plan:keep", pageSender("cloud-plan:keep", () => client().keepPlan()));
  // The room card (the session's `room`): Not now, and Restart now after its upgrade; both for the session's own Cloud.
  ipcMain.handle("cloud-plan:room-not-now", (event, id) => pageSender("cloud-plan:room-not-now", () => client().roomNotNow(typeof id === "string" ? id.slice(0, 64) : ""))(event));
  ipcMain.handle("cloud-plan:restart-now", pageSender("cloud-plan:restart-now", () => client().restartNow()));
  // Contact support: the page's form only; the place (this computer, My Cloud or another Cloud of theirs) and the version are main's.
  ipcMain.handle("cloud-plan:support", (event, input) => {
    if (!outbox) throw new Error("Contact support isn't available here.");
    const send = place => outbox.submit(supportBody(input, { place, appVersion: support.appVersion, platform: `${process.platform} ${process.arch}, desktop app` }));
    const other = otherCloud(event);
    return other ? send(other.id) : pageSender("cloud-plan:support", cloud => send(cloud ? "my-cloud" : "desktop"))(event);
  });
}
