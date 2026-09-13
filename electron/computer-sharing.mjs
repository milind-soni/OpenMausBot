import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createSharedCua, executeSharedOperation, sharedComputerError } from "./shared-computer-access.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export async function validateSharedFolders(folders) {
  if (!Array.isArray(folders) || folders.length > 20) throw new Error("Choose at most 20 shared folders");
  const result = [];
  for (const folder of folders) {
    if (!uuid(folder?.id) || typeof folder.path !== "string" || !path.isAbsolute(folder.path) || typeof folder.write !== "boolean") throw new Error("Choose folders using the desktop folder picker");
    const canonical = await fsp.realpath(folder.path);
    if (!(await fsp.stat(canonical)).isDirectory()) throw new Error("Choose a folder, not a file");
    if (canonical === path.parse(canonical).root || canonical === os.homedir()) throw new Error("Choose specific folders, not the entire computer or home folder");
    if (result.some(entry => entry.id === folder.id || entry.path === canonical)) continue;
    result.push({ id: folder.id, path: canonical, name: path.basename(canonical).slice(0, 120), write: folder.write });
  }
  return result;
}

/** Outbound HTTPS only; no local listening port and no host credentials in
 * the renderer. Pairing cookies and a connector secret remain in Electron. */
export function createComputerSharing({ file, fetch: fetchImpl, environments, cuaConnection, hostControl }) {
  let records = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") records = parsed.records;
  } catch { /* missing/corrupt grants never create authority */ }
  const running = new Map();
  const status = new Map();
  let disposed = false;
  let executing = false;
  const store = next => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: next }), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file); records = next;
  };
  const request = async (env, route, body, signal, secret) => {
    const origin = new URL(env.origin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("Computer sharing requires an HTTPS workspace address");
    const response = await fetchImpl(`${env.origin}${route}`, {
      method: body === undefined ? "GET" : "POST", credentials: "include", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(10_000),
      headers: { origin: env.origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(secret ? { "x-omb-computer-secret": secret } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length; if (bytes > 4_000_000) throw new Error("Workspace response exceeded limit");
      chunks.push(Buffer.from(chunk));
    }
    let json; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("This server does not support computer sharing. Update its OpenMausBot installation."); }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Pair this desktop again before sharing computer access." : `Workspace request failed (${response.status}). Update the server if needed.`);
    return json;
  };
  const identity = async env => {
    const [auth, descriptor] = await Promise.all([request(env, "/api/auth/session"), request(env, "/.well-known/openmausbot/environment")]);
    if (auth.kind !== "session" || !uuid(auth.id) || !uuid(descriptor.environmentId)) throw new Error("Complete workspace pairing or sign-in first");
    if (descriptor.capabilities?.sharedComputers !== true) throw new Error("Update this server to enable computer sharing");
    return { sessionId: auth.id, environmentId: descriptor.environmentId };
  };
  const matches = (grant, info) => grant?.sessionId === info.sessionId && grant?.environmentId === info.environmentId;
  const stop = id => {
    const live = running.get(id);
    if (live) { live.abort.abort(); live.cua?.close(); running.delete(id); }
    status.set(id, { connected: false });
  };
  const run = (env, grant) => {
    stop(env.id);
    if (disposed || !grant.enabled) return;
    const live = { abort: new AbortController(), cua: null };
    running.set(env.id, live);
    const signal = live.abort.signal;
    const call = (action, body = {}) => request(env, `/api/shared-computers/${grant.id}/${action}`, body, signal, grant.secret);
    void (async () => {
      while (!signal.aborted) {
        try {
          if (!matches(grant, await identity(env))) throw new Error("Workspace sign-in changed. Review computer access again in Settings.");
          await validateSharedFolders(grant.folders);
          const effectiveGrant = { ...grant, protectedPaths: [await fsp.realpath(path.dirname(file))] };
          await request(env, "/api/shared-computers/connect", {
            id: grant.id, name: os.hostname().slice(0, 120), environmentId: grant.environmentId,
            folders: grant.folders.map(({ id, name, write }) => ({ id, name, write })), terminal: grant.terminal, computer: grant.computer,
          }, signal, grant.secret);
          if (signal.aborted) break;
          status.set(env.id, { connected: true });
          while (!signal.aborted) {
            const { job } = await call("poll");
            if (!job) continue;
            if (!uuid(job.id) || typeof job.operation !== "object" || job.operation?.computer_id !== grant.id) throw new Error("Invalid computer request");
            if (executing) { await call("result", { jobId: job.id, result: sharedComputerError(new Error("This computer is busy with another workspace")) }); continue; }
            executing = true;
            const jobAbort = new AbortController();
            const jobSignal = AbortSignal.any([signal, jobAbort.signal]);
            let leasing = false;
            let control;
            const lease = async () => {
              if (leasing) return;
              leasing = true;
              try {
                if (!(await call("lease", { jobId: job.id })).active) jobAbort.abort();
                await control?.renew();
              } catch { jobAbort.abort(); }
              finally { leasing = false; }
            };
            const heartbeat = setInterval(() => void lease(), 1000);
            let result;
            try {
              await lease(); jobSignal.throwIfAborted();
              if (grant.computer && ["computer_tools", "computer_call"].includes(job.operation.action)) {
                if (!hostControl) throw new Error("The local computer control gate is unavailable");
                control = await hostControl(job.id, jobSignal);
                jobSignal.throwIfAborted();
              }
              result = await executeSharedOperation(effectiveGrant, job.operation, jobSignal, async () => {
                if (!live.cua) {
                  const connection = await cuaConnection();
                  jobSignal.throwIfAborted();
                  if (!connection?.mcpCommand || !Array.isArray(connection.mcpArgs)) throw new Error("Computer control is unavailable. Enable it in the local app and grant OS permissions first.");
                  live.cua = createSharedCua(connection);
                }
                return live.cua;
              });
            } catch (error) { result = sharedComputerError(error); live.cua?.close(); live.cua = null; }
            finally { clearInterval(heartbeat); await control?.release().catch(() => {}); executing = false; }
            // Never retry an action if the result delivery fails.
            await call("result", { jobId: job.id, result });
          }
        } catch (error) {
          if (!signal.aborted) status.set(env.id, { connected: false, error: error.message });
        }
        try { await delay(5000, undefined, { signal }); } catch { break; }
      }
    })().catch(() => {});
  };
  const state = id => {
    const grant = records[id];
    return { enabled: grant?.enabled === true, folders: Array.isArray(grant?.folders) ? grant.folders : [], terminal: grant?.terminal === true, computer: grant?.computer === true, ...status.get(id) };
  };
  const disconnect = (env, grant) => {
    stop(env.id);
    if (grant?.secret) void request(env, `/api/shared-computers/${grant.id}/disconnect`, {}, undefined, grant.secret).catch(() => {});
  };
  return {
    state, identity,
    async observe(env) {
      const info = await identity(env);
      if (matches(records[env.id], info)) return null;
      disconnect(env, records[env.id]);
      return info;
    },
    decline(env, info) { disconnect(env, records[env.id]); store({ ...records, [env.id]: { ...info, enabled: false, folders: [], terminal: false, computer: false } }); },
    async save(env, input, info) {
      const fresh = await identity(env);
      if (!matches(info, fresh)) throw new Error("Workspace sign-in changed. Review computer access again.");
      const folders = await validateSharedFolders(input.folders);
      const grant = { ...fresh, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true, folders, terminal: input.terminal === true, computer: input.computer === true };
      if (!folders.length && !grant.terminal && !grant.computer) throw new Error("Choose at least one folder or capability to share");
      disconnect(env, records[env.id]);
      store({ ...records, [env.id]: grant }); run(env, grant); return state(env.id);
    },
    revoke(env) {
      disconnect(env, records[env.id]);
      if (records[env.id]) store({ ...records, [env.id]: { ...records[env.id], enabled: false } });
      return state(env.id);
    },
    forget(env) { disconnect(env, records[env.id]); const next = { ...records }; delete next[env.id]; store(next); },
    start() {
      for (const env of environments()) {
        const grant = records[env.id];
        if (grant?.enabled === true && uuid(grant.id) && uuid(grant.sessionId) && uuid(grant.environmentId) && /^[a-f0-9]{64}$/.test(grant.secret) && Array.isArray(grant.folders)) run(env, grant);
      }
    },
    close() { disposed = true; for (const id of running.keys()) stop(id); },
  };
}
