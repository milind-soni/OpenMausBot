import { randomUUID } from "node:crypto";

const downloading = new Set(["checking", "downloading", "preparing"]);
const automatic = app => app?.installMode === "restart" && ["downloaded", ...downloading].includes(app.status);
const permanent = message => Object.assign(new Error(message), { permanent: true });

/** Saved remote servers are authenticated, not trusted to allocate native memory. */
export async function readUpdateResponse(response) {
  const chunks = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) throw permanent("Empty update response.");
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw permanent("Update response too large.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

/** One native-owned plan. No renderer-supplied origins, commands or paths.
 * A failed write is never retried: only read-only readiness probes repeat. */
export function createUpdateEverything({ targets, request, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), save = () => {}, previous, appVersion }) {
  let plan;
  let busy = false;
  let state = previous?.phase === "running" && Array.isArray(previous.rows)
    ? { ...previous, phase: previous.expectedLocalVersion === appVersion ? "complete" : "failed", error: previous.expectedLocalVersion === appVersion ? undefined : "The previous update was interrupted. Check installed versions before continuing." }
    : { phase: "idle", rows: [] };
  let revision = state.revision ?? 0;
  const publish = () => {
    state.revision = ++revision;
    try { save(state); }
    catch {
      state.phase = "failed";
      state.error = "Update progress could not be saved. Check available disk space before trying again.";
      throw new Error(state.error);
    }
    return structuredClone(state);
  };
  const current = target => {
    if (!targets().some(t => !t.unavailable && t.id === target.id && t.origin === target.origin && t.local === target.local)) throw permanent("The saved environment changed. Check again.");
  };
  const read = async target => {
    current(target);
    const snapshot = await request(target, "", undefined);
    if (typeof snapshot?.environmentId !== "string" || typeof snapshot.version !== "string" || typeof snapshot.idle !== "boolean" || !Array.isArray(snapshot.providers) || snapshot.providers.length > 50 || snapshot.providers.some(p => !p || typeof p.instanceId !== "string" || typeof p.name !== "string" || typeof p.key !== "string")) throw permanent("This server needs a manual update before it supports Update everything.");
    return snapshot;
  };
  const fresh = async item => {
    const snapshot = await read(item.target);
    if (snapshot.environmentId !== item.environmentId) throw permanent("This environment was replaced. Check again.");
    return snapshot;
  };
  const wait = async (item, predicate, timeout) => {
    const end = now() + timeout;
    do {
      try { const snapshot = await fresh(item); if (predicate(snapshot)) return snapshot; }
      catch (error) { if (error.permanent) throw error; }
      await sleep(1000);
    } while (now() < end);
    throw new Error("The environment did not reach the expected version. Check it before retrying.");
  };
  return {
    state: () => structuredClone(state),
    async check() {
      if (busy) throw new Error("An update operation is already running.");
      busy = true;
      plan = undefined;
      state = { phase: "checking", rows: [] };
      try {
        publish();
        const items = [];
        for (const target of structuredClone(targets())) {
          const row = { id: target.id, name: target.name, status: "checking", providers: [], app: null };
          state.rows.push(row); publish();
          try {
            if (target.unavailable) throw new Error(target.unavailable);
            let snapshot = await read(target);
            if (snapshot.app?.status !== "operator" && snapshot.app?.status !== "unavailable") {
              await request(target, "/check", { environmentId: snapshot.environmentId });
              snapshot = await read(target);
            }
            const providers = snapshot.providers.filter(p => typeof p.instanceId === "string" && typeof p.name === "string" && typeof p.key === "string");
            row.providers = providers.map(p => p.name);
            row.app = automatic(snapshot.app) ? snapshot.app.version ?? null : null;
            row.note = snapshot.app?.status === "operator" ? "Server software is operator-managed; only providers can update here."
              : snapshot.app?.status === "unavailable" ? "Automatic app updates are unavailable on this installation."
              : snapshot.app?.installMode === "handoff" ? "The app package needs a manual install on this machine."
              : undefined;
            if (Array.isArray(snapshot.manualProviders) && snapshot.manualProviders.length) row.note = [row.note, `Update manually: ${snapshot.manualProviders.filter(p => typeof p === "string").join(", ")}.`].filter(Boolean).join(" ");
            if (snapshot.app?.status === "error") throw new Error("The app update check failed. Open Updates on that machine.");
            if (!snapshot.idle) throw new Error("Finish running turns, approvals and calls on this environment before updating.");
            row.status = providers.length || row.app ? "ready" : "current";
            items.push({ target, environmentId: snapshot.environmentId, providers: providers.map(p => ({ instanceId: p.instanceId, key: p.key })), version: row.app, row });
          } catch (error) { row.status = "skipped"; row.note = error.message; }
          publish();
        }
        plan = { id: randomUUID(), expires: now() + 5 * 60_000, items };
        state = { ...state, phase: "ready", planId: plan.id };
        return publish();
      } finally { busy = false; }
    },
    async run(id) {
      if (busy) throw new Error("An update operation is already running.");
      if (!plan || plan.id !== id || plan.expires < now()) throw new Error("Check for updates again before continuing.");
      const selected = plan;
      plan = undefined; // one-use; a lost response cannot repeat an installer
      busy = true;
      state.phase = "running";
      try {
        publish();
        // Complete ALL provider installs before ANY server/app restart.
        for (const item of selected.items) {
          if (!item.providers.length) continue;
          item.row.status = "providers"; publish();
          const snapshot = await fresh(item);
          if (!snapshot.idle || item.providers.some(p => !snapshot.providers.some(q => q.instanceId === p.instanceId && q.key === p.key))) throw permanent("Provider settings or running work changed. Check again.");
          current(item.target);
          await request(item.target, "/providers", { environmentId: item.environmentId, instances: item.providers });
          item.row.status = "updated"; publish();
        }
        // Local is last: its restart closes this coordinator. The remote
        // desktop's own signed update feed is the only source of its version.
        for (const item of [...selected.items].sort((a, b) => Number(a.target.local) - Number(b.target.local))) {
          if (!item.version) continue;
          item.row.status = "downloading"; publish();
          const snapshot = await wait(item, s => !downloading.has(s.app?.status), 15 * 60_000);
          if (snapshot.app?.status !== "downloaded" || snapshot.app.version !== item.version || !snapshot.idle) throw new Error("The update or running work changed. Check again before restarting.");
          item.row.status = "restarting";
          if (item.target.local) state.expectedLocalVersion = item.version;
          publish();
          current(item.target);
          await request(item.target, "/install", { environmentId: item.environmentId, version: item.version });
          await wait(item, s => s.version === item.version, 120_000);
          item.row.status = "updated"; publish();
        }
        state.phase = "complete";
        return publish();
      } catch (error) {
        state.phase = "failed";
        state.error = error.message;
        // A partial failure never disappears behind a local restart.
        return publish();
      } finally { busy = false; }
    },
  };
}
