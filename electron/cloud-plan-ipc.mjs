import { cloudPlanSnapshot, UPGRADE_SOURCES } from "./cloud-account.mjs";

// Security: an upgrade goes only to a plan the verified session lists, and only with the confirmation main kept from its
// own preview; a page never holds it.
export function installCloudPlanIpc({ ipcMain, pageSender, account, client, notices, homePage }) {
  ipcMain.handle("cloud-plan:state", event => pageSender("cloud-plan:state", () => {
    const state = account()?.state();
    return { ...cloudPlanSnapshot(state, { notice: notices().due(state) }), ...(homePage(event) ? { home: true } : {}) };
  })(event));
  ipcMain.handle("cloud-plan:notice-seen", pageSender("cloud-plan:notice-seen", () => { notices().seen(account()?.state()); }));
  ipcMain.handle("cloud-plan:manage", pageSender("cloud-plan:manage", async () => { await client().openDashboard(); }));
  const upgradeArgs = (plan, source) => {
    const offered = client().state().usage?.upgrades ?? [];
    if (typeof plan !== "string" || !UPGRADE_SOURCES.includes(source) || !offered.some(entry => entry.tier === plan)) throw new Error("Choose a plan to move to.");
    return [plan, source];
  };
  ipcMain.handle("cloud-plan:upgrade-preview", (event, plan, source) => pageSender("cloud-plan:upgrade-preview", () => client().upgradePreview(...upgradeArgs(plan, source)))(event));
  ipcMain.handle("cloud-plan:upgrade", (event, plan, source) => pageSender("cloud-plan:upgrade", () => client().upgrade(...upgradeArgs(plan, source)))(event));
}
