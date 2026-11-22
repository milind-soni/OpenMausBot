import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

const phone: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-1" };
const desktop: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

async function put(auth: RequestAuth, body: unknown, method = "PUT") {
  const replies: Array<{ status: number; body: unknown }> = [];
  // A busy provider config answers 409 only after the phone guard, so a 409 means the guard let it through.
  const route = createConfigRoutes({ hostedModels: false, providerConfigBusy: { get: () => true } } as unknown as ConfigRouteDeps);
  await route({
    req: {}, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method, auth,
    json: (_res: unknown, status: number, reply: unknown) => { replies.push({ status, body: reply }); },
    readBody: async () => body,
  } as unknown as Parameters<typeof route>[0]);
  return replies[0];
}

const SENTENCE = "From a phone, only API keys can be changed. Change other settings on your computer.";

describe("config writes from a paired phone", () => {
  it.each([
    { mistral: { key: "k" } },
    { openai: { key: "" } },
    { anthropic: { key: "k", everyClaudeBot: false } },
  ])("lets a key-only patch past the guard: %j", async (body) => {
    expect((await put(phone, body))?.status).toBe(409);
  });

  it.each([
    { signIn: { admins: ["a@b.c"] } },
    { browserEngine: { egress: { proxy: "socks5://127.0.0.1:1080" } } },
    { openaiCompat: { key: "k" } },
    { openai: { key: "k", url: "http://evil.test/v1" } },
    { mistral: { key: "k", everyClaudeBot: true } },
    { mistral: { key: 5 } },
    { mistral: { key: "k" }, signIn: { admins: [] } },
    { mistral: "k" },
    { toString: { key: "k" } },
    {},
  ])("refuses anything else: %j", async (body) => {
    expect(await put(phone, body)).toEqual({ status: 403, body: { error: SENTENCE } });
    expect(await put(phone, body, "PATCH")).toEqual({ status: 403, body: { error: SENTENCE } });
  });

  it("leaves the desktop's own write alone", async () => {
    expect(await put(desktop, {})).toEqual({ status: 400, body: { error: "nothing to save" } });
    expect((await put(desktop, { signIn: { admins: [] } }))?.status).toBe(409);
  });
});
