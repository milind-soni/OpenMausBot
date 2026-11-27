// The channels behind Update all on Settings → Devices (`guard`: this computer's own page only). The page names saved
// servers by id only: each origin comes from this app's own saved list, and each target from that server's own answer.
import { appUpdater } from "./updater.mjs";
import { appPlan, createUpdateAll, serverPlan, surveyServer } from "./update-all-run.mjs";

/** `servers()`: the saved servers Settings checks (`{ id, origin }`); `fetch`: the session that holds their sign-ins;
 * `send(channel, value)`: to this app's own window. */
export function installUpdateAll({ ipcMain, guard, servers, fetch: fetchImpl, send, app = appUpdater() }) {
  let looked = new Map();
  const run = createUpdateAll({ fetch: fetchImpl, app, onChange: (view) => send("update-all:state", view) });
  const savedServer = (id) => servers().find((entry) => entry.id === id && entry.origin);

  async function survey(fresh) {
    const answers = await Promise.all(servers().filter((entry) => entry.origin).map(async ({ id, origin }) =>
      ({ id, origin, plan: serverPlan(await surveyServer(origin, fetchImpl, { fresh })) })));
    looked = new Map(answers.map((answer) => [answer.id, answer]));
    return { servers: answers.map(({ id, plan }) => ({ id, plan })), app: appPlan(app?.state()), view: run.view() };
  }

  ipcMain.handle("update-all:survey", guard("update-all:survey", (_event, fresh) => survey(fresh === true)));
  ipcMain.handle("update-all:state", guard("update-all:state", () => run.view()));
  ipcMain.handle("update-all:start", guard("update-all:start", (_event, ids, withApp) => {
    const wanted = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
    const chosen = [...looked.values()]
      .filter((answer) => wanted.has(answer.id) && answer.plan.updates && savedServer(answer.id)?.origin === answer.origin)
      .map(({ id, origin, plan }) => ({ id, origin, latest: plan.latest }));
    return run.start({ servers: chosen, withApp: withApp === true && Boolean(appPlan(app?.state())) });
  }));
  ipcMain.handle("update-all:retry", guard("update-all:retry", async (_event, id) => {
    if (id === "app") return run.retry("app");
    const entry = typeof id === "string" ? savedServer(id) : undefined;
    if (!entry) return run.view();
    const plan = serverPlan(await surveyServer(entry.origin, fetchImpl, { fresh: true }));
    if (plan.updates) return run.retry(id, { origin: entry.origin, latest: plan.latest });
    if (plan.why === "up-to-date") return run.retry(id, { origin: entry.origin, current: true });
    return run.retry(id, { failure: { why: plan.why, ...(plan.command ? { command: plan.command } : {}) } });
  }));
}
