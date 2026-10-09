import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteDesktopApproval } from "./remote-desktop-approval.ts";
import type { RouteContext } from "./routes/table.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); vi.useRealTimers(); });
function fixture(recovery?: object[]) {
  const home = mkdtempSync(join(tmpdir(), "omb-remote-authority-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "recovery.json");
  if (recovery) writeFileSync(file, JSON.stringify(recovery));
  let live = true;
  const messages: Record<string, unknown>[] = [];
  const revoke = vi.fn();
  const service = createRemoteDesktopApproval({
    file, workspace: "workspace", available: () => true, liveAdmin: () => live,
    post: message => messages.push(message as Record<string, unknown>), revoke, isFull: () => true,
  });
  cleanup.push(() => service.close());
  const session = { kind: "session", via: "cookie", session: { id: "device" }, scopes: ["admin"] };
  function request(method = "GET", body?: object, auth: object = session) {
    const response = new EventEmitter();
    let status = 0;
    let result: Record<string, unknown> = {};
    const context = {
      path: "/api/desktop-approval", method, auth,
      req: { headers: { host: "mini.ts.net", origin: "http://mini.ts.net" } }, res: response,
      readBody: async () => body,
      json: (_res: unknown, code: number, value: Record<string, unknown>) => { status = code; result = value; },
    } as unknown as RouteContext;
    return { done: service.route(context), response, status: () => status, result: () => result };
  }
  async function begin() {
    const info = request(); await info.done;
    const claim = { action: "full", ...info.result(), origin: "http://mini.ts.net", botId: "bot", threadId: "thread", mode: "full", grantId: "grant" };
    const req = request("POST", { claim });
    await Promise.resolve();
    const id = messages.at(-1)!.id as string;
    return { req, claim, id };
  }
  const set = (id: string) => ({ type: "approval-trusted-mode-set", requestId: "private", remoteRequestId: id, botId: "bot", threadId: "thread", mode: "full", threadOnly: true });
  return { service, file, messages, revoke, request, begin, set, unpair: () => { live = false; } };
}

describe("remote desktop courier and recovery", () => {
  it("refuses loopback, bearer-only and chat-only callers before contacting main", async () => {
    const f = fixture();
    for (const auth of [
      { kind: "loopback", scopes: ["admin"] },
      { kind: "session", via: "bearer", session: { id: "device" }, scopes: ["admin"] },
      { kind: "session", via: "cookie", session: { id: "device" }, scopes: ["client"] },
    ]) {
      const req = f.request("POST", {}, auth); await req.done; expect(req.status()).toBe(403);
    }
    expect(f.messages).toEqual([]);
  });
  it("ordinary admin HTTP cannot approve its own request", async () => {
    const f = fixture();
    const { req, id } = await f.begin();
    expect(req.status()).toBe(0);
    f.service.receive({ type: "remote-approval-result", id: "wrong", ok: true });
    expect(req.status()).toBe(0);
    f.service.receive({ type: "remote-approval-result", id, ok: false });
    await req.done;
    expect(req.status()).toBe(403);
    expect(f.revoke).not.toHaveBeenCalled();
  });
  it("journals before the private grant and recovers at lease expiry", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { req, id } = await f.begin();
    expect(f.service.guard(f.set(id))).toBe(false);
    expect(JSON.parse(readFileSync(f.file, "utf8"))[0].threadId).toBe("thread");
    f.service.receive({ type: "remote-approval-result", id, ok: true, result: { bot: {} } });
    await req.done;
    await vi.advanceTimersByTimeAsync(20_500);
    expect(f.revoke).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot", threadId: "thread" }));
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual([]);
  });
  it("checks revoked pairing again before every private phase", async () => {
    const f = fixture();
    const { req, id } = await f.begin();
    f.service.guard(f.set(id));
    f.unpair();
    for (const phase of ["confirm", "activate", "finalize", "commit"]) {
      expect(f.service.guard({ ...f.set(id), type: `approval-trusted-mode-${phase}` })).toBe(true);
      expect(f.messages.at(-1)).toMatchObject({ ok: false });
    }
    f.service.receive({ type: "remote-approval-result", id, ok: true });
    await req.done; expect(req.status()).toBe(403);
    expect(f.revoke).toHaveBeenCalledTimes(1);
  });
  it("recovers a dropped request and refuses late commit", async () => {
    const f = fixture();
    const { req, id } = await f.begin();
    f.service.guard(f.set(id));
    req.response.emit("close"); await req.done;
    expect(f.revoke).toHaveBeenCalledTimes(1);
    expect(f.service.guard({ ...f.set(id), type: "approval-trusted-mode-commit" })).toBe(true);
  });
  it("recovers a host crash from durable scope without touching siblings/default", () => {
    const scope = { botId: "bot", threadId: "selected", grantId: "old", device: "device" };
    const f = fixture([scope]);
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith(scope);
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toEqual([]);
  });
  it("a refused local selection cannot discard the remote recovery journal", async () => {
    const f = fixture();
    const { req, id } = await f.begin();
    f.service.guard(f.set(id));
    f.service.receive({ type: "remote-approval-result", id, ok: true }); await req.done;
    f.service.guard({ ...f.set(id), remoteRequestId: undefined });
    f.service.observeResult({ type: "approval-trusted-mode-result", requestId: "private", ok: false });
    expect(JSON.parse(readFileSync(f.file, "utf8"))).toHaveLength(1);
    expect(f.service.guard({ ...f.set(id), mode: "ask", remoteRequestId: undefined, remoteRecoveryGrantId: "grant" })).toBe(false);
    expect(f.revoke).toHaveBeenCalledTimes(1);
  });
  it("a newer local selection is not undone by a delayed remote compensation", async () => {
    const f = fixture();
    const { req, id } = await f.begin();
    f.service.guard(f.set(id));
    f.service.receive({ type: "remote-approval-result", id, ok: true }); await req.done;
    f.service.guard({ ...f.set(id), remoteRequestId: undefined });
    f.service.observeResult({ type: "approval-trusted-mode-commit-result", requestId: "private", ok: true });
    expect(f.service.guard({ ...f.set(id), mode: "ask", remoteRequestId: undefined, remoteRecoveryGrantId: "grant" })).toBe(true);
    expect(f.revoke).not.toHaveBeenCalled();
  });
});
