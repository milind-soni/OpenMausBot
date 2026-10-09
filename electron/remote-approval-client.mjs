import { randomUUID, createHash } from "node:crypto";
import { createDesktopKey, fingerprint, signedRequest } from "./remote-approval-authority.mjs";
import { FULL_ACCESS_WARNING } from "../shared/full-access-warning.mjs";

export function approvalOrigin(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password ||
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname.endsWith(".ts.net")))) {
    throw new Error("Desktop approvals require HTTPS or a Tailscale .ts.net address");
  }
  return origin;
}

/** The saved-environment path uses its Chromium session cookie, but signs
 * with a separate OS-encrypted native key. Nothing exposes a signing API. */
export function createRemoteApprovalClient({ read, update, current, fetch, dialog }) {
  const leases = new Map();
  let prompting = false;
  const keyId = origin => createHash("sha256").update(origin).digest("hex");
  async function json(origin, packet) {
    const response = await fetch(`${approvalOrigin(origin)}/api/desktop-approval`, {
      method: packet ? "POST" : "GET", redirect: "error", credentials: "include",
      headers: { "content-type": "application/json", origin },
      ...(packet ? { body: JSON.stringify(packet) } : {}), signal: AbortSignal.timeout(14_000),
    });
    if (!response.ok) throw new Error("Desktop approval unavailable. Check host enrollment and pairing.");
    return response.json();
  }
  function selected() {
    const env = current();
    if (!env) throw new Error("Select the paired remote server first");
    approvalOrigin(env.origin);
    return env;
  }
  async function identity(env) {
    const info = await json(env.origin);
    if (current()?.origin !== env.origin || typeof info.workspace !== "string" || typeof info.device !== "string") throw new Error("Server connection changed");
    return { workspace: info.workspace, device: info.device, origin: env.origin, epoch: info.epoch };
  }
  async function cancel(row) {
    clearInterval(row.timer);
    leases.delete(row.scope.grantId);
    try { await json(row.scope.origin, signedRequest(row.key, { ...row.scope, action: "cancel" })); } catch { /* host lease expires to Ask */ }
  }
  return {
    async status() {
      try {
        const env = selected();
        const key = read().remoteApprovalKeys?.[keyId(env.origin)];
        if (!key) return { available: false };
        return await json(env.origin, signedRequest(key, { ...await identity(env), action: "status" }));
      } catch { return { available: false }; }
    },
    async enroll() {
      const env = selected();
      const scope = await identity(env);
      const id = keyId(env.origin);
      if (!read().remoteApprovalKeys?.[id]) {
        await update(doc => ({ ...doc, remoteApprovalKeys: { ...doc.remoteApprovalKeys, [id]: createDesktopKey() } }));
      }
      const key = read().remoteApprovalKeys[id];
      await json(env.origin, signedRequest(key, { ...scope, action: "enroll" }));
      await dialog({ type: "info", buttons: ["Done"], message: "Authorize this laptop on the host once",
        detail: `${env.name}\n${env.origin}\n\nOn the host, open Server → Desktop approval devices. Confirm this exact fingerprint and device:\n\n${fingerprint(key.publicKey)}\nDevice: ${scope.device}\n\nThe request expires in two minutes. Existing pairing alone does not allow Full access.` });
    },
    async setFull(botId, threadId) {
      if (prompting) throw new Error("A desktop approval dialog is already open");
      if (!/^[\w-]{1,120}$/.test(botId) || !/^[\w-]{1,120}$/.test(threadId)) throw new Error("Invalid conversation");
      prompting = true;
      let row;
      try {
        const env = selected();
        const key = read().remoteApprovalKeys?.[keyId(env.origin)];
        if (!key) throw new Error("Use Server → Authorize this laptop for Full access first");
        const scope = { ...await identity(env), botId, threadId, mode: "full", grantId: randomUUID() };
        await json(env.origin, signedRequest(key, { ...scope, action: "status" }));
        const answer = await dialog({ type: "warning", buttons: ["Cancel", "Enable Full access"], defaultId: 0, cancelId: 0,
          message: "Enable Full access for this conversation?",
          detail: `${env.name}\n${env.origin}\nBot: ${botId}\nConversation: ${threadId}\n\n${FULL_ACCESS_WARNING}\n\nOnly this conversation changes. Keep this desktop connected; connection loss returns it to Ask within 20 seconds.` });
        if (answer.response !== 1) throw new Error("Full access cancelled");
        const latest = await identity(env);
        if (latest.device !== scope.device || latest.workspace !== scope.workspace || latest.epoch !== scope.epoch) throw new Error("Pairing changed during confirmation");
        row = { key, scope, timer: null, renewing: false };
        const result = await json(env.origin, signedRequest(key, { ...scope, action: "full" }));
        if (current()?.origin !== env.origin || !result.bot || result.bot.id !== botId ||
          result.bot.tasks?.find(task => task.threadId === threadId)?.approvalMode !== "full") throw new Error("Host did not commit this conversation");
        leases.set(scope.grantId, row);
        row.timer = setInterval(async () => {
          if (row.renewing) return;
          row.renewing = true;
          try {
            if (current()?.origin !== env.origin) throw new Error("Connection changed");
            await json(env.origin, signedRequest(key, { ...scope, action: "renew" }));
          } catch { await cancel(row); }
          finally { row.renewing = false; }
        }, 4_000);
        row.timer.unref?.();
        return result.bot;
      } catch (error) {
        if (row) await cancel(row);
        throw error;
      } finally { prompting = false; }
    },
    async stop() { await Promise.all([...leases.values()].map(cancel)); },
  };
}
