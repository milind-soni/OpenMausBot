import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import type { RouteContext } from "./table.ts";
import { createTelephonyRoutes } from "./telephony.ts";
import type { TelephonyConfig } from "../telephony/service.ts";
import { openTelephonyStore, type TelephonyStore } from "../telephony/store.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const baseConfig: TelephonyConfig = {
  accountSid: "ACtest",
  authUser: "ACtest",
  authToken: "test-token",
  botPhoneNumber: "+15186608998",
  ownerPhoneNumber: "+15187446390",
  publicUrl: "https://bots.example",
};

interface Ctx {
  ctx: RouteContext;
  status: () => number;
  body: () => Record<string, unknown>;
  headers: () => Record<string, string>;
}

function makeCtx(method: string, path: string, body?: unknown): Ctx {
  let code = 0;
  let sent: Record<string, unknown> = {};
  const heads: Record<string, string> = {};
  const res = {
    writeHead(c: number, h?: Record<string, string>) {
      code = c;
      Object.assign(heads, h ?? {});
      return this;
    },
    end(data?: string) {
      if (data) sent = JSON.parse(data) as Record<string, unknown>;
      return this;
    },
  } as unknown as ServerResponse;
  const ctx = {
    req: {},
    res,
    url: new URL(`http://127.0.0.1:1${path}`),
    path,
    method,
    auth: { everything: true },
    json: (_res: ServerResponse, status: number, payload: Record<string, unknown>) => {
      code = status;
      sent = payload;
    },
    readBody: async () => body ?? {},
  } as unknown as RouteContext;
  return { ctx, status: () => code, body: () => sent, headers: () => heads };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routes-telephony-"));
  dirs.push(dir);
  const store: TelephonyStore = openTelephonyStore(join(dir, "telephony", "store.json"));
  return store;
}

describe("Telephony app routes", () => {
  it("reports the wiring without leaking the auth token", async () => {
    const store = fixture();
    const routes = createTelephonyRoutes({ store, config: () => baseConfig });
    const { ctx, status, body } = makeCtx("GET", "/api/telephony/status");
    await routes(ctx);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ configured: true, outboundPolicy: "ask", botPhoneNumber: "+15186608998" });
    expect(JSON.stringify(body())).not.toContain("test-token");
  });

  it("lists the shared SMS and call records", async () => {
    const store = fixture();
    store.appendSms({ direction: "in", from: "+15187446390", to: "+15186608998", body: "lunch?", at: 1, status: "received" });
    store.appendCall({ direction: "in", from: "+15187446390", to: "+15186608998", at: 2, status: "answered" });
    const routes = createTelephonyRoutes({ store, config: () => baseConfig });
    const sms = makeCtx("GET", "/api/telephony/sms");
    await routes(sms.ctx);
    expect((sms.body().messages as Array<{ body: string }>)[0]!.body).toBe("lunch?");
    const calls = makeCtx("GET", "/api/telephony/calls");
    await routes(calls.ctx);
    expect((calls.body().calls as Array<{ status: string }>)[0]!.status).toBe("answered");
  });

  it("refuses an outbound SMS without approval, then sends the approved one", async () => {
    const store = fixture();
    const posted: string[] = [];
    const twilio = (async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ sid: "SMtest" }), { status: 201 });
    }) as typeof fetch;
    const routes = createTelephonyRoutes({ store, config: () => baseConfig, fetch: twilio });

    const refused = makeCtx("POST", "/api/telephony/sms/outbound", { to: "+15187446390", body: "on my way" });
    await routes(refused.ctx);
    expect(refused.status()).toBe(403);
    expect(posted).toHaveLength(0);

    const sent = makeCtx("POST", "/api/telephony/sms/outbound", { to: "+15187446390", body: "on my way", approved: true });
    await routes(sent.ctx);
    expect(sent.status()).toBe(200);
    expect(posted[0]).toContain("Body=on+my+way");
    expect(store.listSms()[0]!.status).toBe("sent");
  });

  it("approves a drafted reply to the owner's SMS by id", async () => {
    const store = fixture();
    const inbound = store.appendSms({
      direction: "in",
      from: "+15187446390",
      to: "+15186608998",
      body: "lunch?",
      at: 1,
      status: "received",
      proposedReply: "Yes, at one.",
    });
    const posted: string[] = [];
    const twilio = (async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ sid: "SMreply" }), { status: 201 });
    }) as typeof fetch;
    const routes = createTelephonyRoutes({ store, config: () => baseConfig, fetch: twilio });

    const ok = makeCtx("POST", "/api/telephony/sms/approve", { smsId: inbound.id });
    await routes(ok.ctx);
    expect(ok.status()).toBe(200);
    expect(posted[0]).toContain(encodeURIComponent("+15187446390"));
    expect(store.listSms().find((s) => s.id === inbound.id)!.status).toBe("sent");
  });

  it("rejects a drafted reply and marks it ignored", async () => {
    const store = fixture();
    const inbound = store.appendSms({
      direction: "in",
      from: "+15187446390",
      to: "+15186608998",
      body: "lunch?",
      at: 1,
      status: "received",
      proposedReply: "Yes, at one.",
    });
    const routes = createTelephonyRoutes({ store, config: () => baseConfig, fetch: (async () => {
      throw new Error("must not send");
    }) as typeof fetch });
    const reject = makeCtx("POST", "/api/telephony/sms/reject", { smsId: inbound.id });
    await routes(reject.ctx);
    expect(reject.status()).toBe(200);
    expect(store.listSms().find((s) => s.id === inbound.id)!.status).toBe("ignored");
  });

  it("refuses an outbound call without approval, then places the approved one", async () => {
    const store = fixture();
    const posted: string[] = [];
    const twilio = (async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ sid: "CAtest" }), { status: 201 });
    }) as typeof fetch;
    const routes = createTelephonyRoutes({ store, config: () => baseConfig, fetch: twilio });

    const refused = makeCtx("POST", "/api/telephony/calls/outbound", { to: "+15187446390", objective: "confirm lunch" });
    await routes(refused.ctx);
    expect(refused.status()).toBe(403);
    expect(posted).toHaveLength(0);

    const sent = makeCtx("POST", "/api/telephony/calls/outbound", { to: "+15187446390", objective: "confirm lunch", approved: true });
    await routes(sent.ctx);
    expect(sent.status()).toBe(200);
    expect(posted[0]).toContain(encodeURIComponent("https://bots.example/hooks/telephony/voice/outbound"));
    expect(store.listCalls()[0]!.status).toBe("ringing");
  });

  it("lets an explicit allow policy send without per-request approval", async () => {
    const store = fixture();
    const twilio = (async () => new Response(JSON.stringify({ sid: "SMauto" }), { status: 201 })) as typeof fetch;
    const routes = createTelephonyRoutes({ store, config: () => baseConfig, fetch: twilio, outboundPolicy: () => "allow" });
    const sent = makeCtx("POST", "/api/telephony/sms/outbound", { to: "+15187446390", body: "auto reply" });
    await routes(sent.ctx);
    expect(sent.status()).toBe(200);
  });
});
