import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PASS, type RouteHandler } from "./routes/table.ts";
import { requestOrigin } from "./request-auth.ts";

type Scope = { botId: string; threadId: string; grantId: string; device: string };
type Claim = Scope & { epoch: string; action: string; workspace: string; origin: string };
type Pending = { claim: Claim; device: string; origin: string; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const LEASE_MS = 20_000;

/** An authenticated courier, never an elevation authority. Only the private
 * parent response can finish a request. The parent verifies the desktop key.
 * A durable recovery journal makes both laptop loss and host restart Ask. */
export function createRemoteDesktopApproval(deps: {
  workspace: string;
  file: string;
  available: () => boolean;
  liveAdmin: (device: string) => boolean;
  post: (message: object) => void;
  revoke: (scope: Scope) => void;
  isFull: (scope: Scope) => boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const epoch = randomUUID();
  const requests = new Map<string, Pending>();
  const localSelections = new Map<string, { botId: string | undefined; threadId: string | undefined;
    allThreads: boolean | undefined; mode: string | undefined; expires: number }>();
  const leases = new Map<string, Scope & { expires: number; requestId: string }>();
  const save = () => {
    writeFileSync(`${deps.file}.tmp`, JSON.stringify([...leases.values()]), { mode: 0o600 });
    renameSync(`${deps.file}.tmp`, deps.file);
  };
  // A malformed journal is a startup failure, never permission to resume Full.
  if (existsSync(deps.file)) {
    const rows = JSON.parse(readFileSync(deps.file, "utf8"));
    if (!Array.isArray(rows)) throw new Error("Invalid remote approval recovery journal");
    for (const row of rows) {
      if (!row || typeof row.botId !== "string" || !/^[\w-]{1,120}$/.test(row.botId) ||
          typeof row.threadId !== "string" || !/^[\w-]{1,120}$/.test(row.threadId)) throw new Error("Invalid remote approval recovery scope");
      deps.revoke(row);
    }
    save();
  }
  function revoke(id: string) {
    const row = leases.get(id);
    if (!row) return;
    deps.revoke(row);
    leases.delete(id);
    save();
  }
  const sweep = setInterval(() => {
    for (const [id, row] of leases) if (row.expires <= now() || !deps.liveAdmin(row.device)) revoke(id);
  }, 500);
  sweep.unref();
  const route: RouteHandler = async ({ path, method, auth, req, res, json, readBody }) => {
    if (path !== "/api/desktop-approval") return PASS;
    if (!deps.available()) return json(res, 503, { error: "A packaged host desktop is required" });
    if (auth.kind !== "session" || auth.via !== "cookie" || !auth.scopes.includes("admin") || !deps.liveAdmin(auth.session.id)) {
      return json(res, 403, { error: "A paired desktop session is required" });
    }
    if (method === "GET") return json(res, 200, { workspace: deps.workspace, device: auth.session.id, epoch });
    if (method !== "POST") return json(res, 405, { error: "Unsupported desktop request" });
    try {
      const packet = await readBody(req);
      const claim = packet?.claim as Claim;
      const origin = requestOrigin(req);
      if (!deps.liveAdmin(auth.session.id) || !origin || req.headers.origin !== origin ||
          claim?.epoch !== epoch || claim?.workspace !== deps.workspace || claim?.device !== auth.session.id || claim?.origin !== origin) {
        return json(res, 403, { error: "Desktop pairing or target changed" });
      }
      if (requests.size >= 64) return json(res, 429, { error: "Too many desktop requests" });
      const id = randomUUID();
      const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error("Host desktop did not answer")); }, 12_000);
        timer.unref();
        requests.set(id, { claim, device: auth.session.id, origin, resolve, reject, timer });
        res.once("close", () => {
          const pending = requests.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          requests.delete(id);
          reject(new Error("Desktop transport disconnected"));
          if (claim.action === "full" && leases.get(claim.grantId)?.requestId === id) revoke(claim.grantId);
        });
        deps.post({ type: "remote-approval-request", id, packet,
          context: { epoch, workspace: deps.workspace, device: auth.session.id, origin, requestId: id } });
      });
      if (!deps.liveAdmin(auth.session.id)) throw new Error("Pairing revoked");
      if (claim.action === "renew") {
        const lease = leases.get(claim.grantId);
        if (!lease || !deps.isFull(lease) || lease.device !== auth.session.id || lease.botId !== claim.botId || lease.threadId !== claim.threadId) throw new Error("Grant ended");
        lease.expires = now() + LEASE_MS;
      }
      if (claim.action === "cancel") revoke(claim.grantId);
      return json(res, 200, answer);
    } catch (error) {
      if (!res.destroyed) return json(res, 403, { error: error instanceof Error ? error.message : "Desktop approval refused" });
    }
  };
  return {
    route,
    receive(raw: unknown) {
      const message = raw as { type?: string; id?: string; ok?: boolean; result?: Record<string, unknown>;
        context?: { epoch: string; workspace: string; device: string } };
      if (message?.type === "remote-approval-validate") {
        deps.post({ type: "remote-approval-validated", id: message.id, ok: Boolean(message.context &&
          message.context.epoch === epoch && message.context.workspace === deps.workspace && deps.liveAdmin(message.context.device)) });
        return true;
      }
      if (message?.type !== "remote-approval-result") return false;
      const pending = requests.get(message.id!);
      if (!pending) return true;
      requests.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.ok && deps.liveAdmin(pending.device)) pending.resolve(message.result ?? {});
      else pending.reject(new Error("Desktop authority refused the request; check enrollment and pairing"));
      return true;
    },
    /** Called before EVERY private protocol phase. A revoke or disconnect
     * during the handshake must not be followed by activation/commit. */
    guard(raw: unknown): boolean {
      const message = raw as { type?: string; remoteRequestId?: string; remoteRecoveryGrantId?: string; requestId?: string; botId?: string; threadId?: string; mode?: string; threadOnly?: boolean; allThreads?: boolean };
      if (!message?.type?.startsWith("approval-trusted-mode-")) return false;
      if (message.remoteRecoveryGrantId) {
        const lease = leases.get(message.remoteRecoveryGrantId);
        if (!lease || message.type !== "approval-trusted-mode-set" || message.mode !== "ask" ||
            message.botId !== lease.botId || message.threadId !== lease.threadId || !message.threadOnly || message.allThreads) {
          deps.post({ type: "approval-trusted-mode-result", requestId: message.requestId, ok: false });
          return true;
        }
        // Revoke synchronously and durably before the normal Ask response.
        revoke(message.remoteRecoveryGrantId);
        return false;
      }
      if (!message.remoteRequestId) {
        // Record intent, but retain remote recovery until the local private
        // transition really succeeds. A refused local change owns nothing.
        for (const [id, selection] of localSelections) if (selection.expires <= now()) localSelections.delete(id);
        if (message.type === "approval-trusted-mode-set" && message.requestId) {
          localSelections.set(message.requestId, { botId: message.botId, threadId: message.threadId,
            allThreads: message.allThreads, mode: message.mode, expires: now() + 60_000 });
        }
        return false;
      }
      const pending = requests.get(message.remoteRequestId);
      const c = pending?.claim;
      const valid = pending && c && c.action === "full" && deps.liveAdmin(pending.device) &&
        message.botId === c.botId && message.mode === "full" &&
        (message.type !== "approval-trusted-mode-set" || (message.threadId === c.threadId && message.threadOnly === true && !message.allThreads));
      if (!valid) {
        deps.post({ type: message.type === "approval-trusted-mode-set" ? "approval-trusted-mode-result" : `${message.type}-result`, requestId: message.requestId, ok: false });
        if (c) revoke(c.grantId);
        return true;
      }
      if (message.type === "approval-trusted-mode-set") {
        leases.set(c.grantId, { botId: c.botId, threadId: c.threadId, grantId: c.grantId, device: pending.device, requestId: message.remoteRequestId, expires: now() + LEASE_MS });
        save(); // durable BEFORE any elevated setting can be persisted
      }
      return false;
    },
    observeResult(raw: unknown) {
      const message = raw as { type?: string; requestId?: string; ok?: boolean };
      if (!message?.requestId || !message.type?.startsWith("approval-trusted-mode-")) return;
      const selection = localSelections.get(message.requestId);
      if (!selection) return;
      if (!message.ok) { localSelections.delete(message.requestId); return; }
      const elevated = selection.mode === "full" || selection.mode === "custom";
      if (message.type !== (elevated ? "approval-trusted-mode-commit-result" : "approval-trusted-mode-result")) return;
      localSelections.delete(message.requestId);
      let changed = false;
      for (const [id, lease] of leases) {
        if (selection.botId === lease.botId && (selection.allThreads || selection.threadId === lease.threadId)) {
          leases.delete(id); changed = true;
        }
      }
      if (changed) save();
    },
    close() { clearInterval(sweep); for (const id of leases.keys()) revoke(id); },
  };
}
