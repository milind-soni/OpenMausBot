import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CredentialConfig } from "../../shared/credential-request.ts";
import { PhoneSecretBridge, phoneMoveKeyAAD } from "../phone-secret.ts";
import { createPhoneMoveIn } from "../phone-move-in.ts";
import type { RequestAuth } from "../request-auth.ts";
import { keyMaterial, seal } from "../testing/phone-secret-seal.ts";
import { createPhoneMoveKeyRoutes } from "./phone-move-key.ts";
import type { RouteContext } from "./table.ts";

const KEY = "sk-ant-fake-move-7f3a";
const PATH = "/api/phone-move/key";
const GRANT: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-1", companionMove: true };
const { moving } = createPhoneMoveIn({ dataDir: "/nonexistent-phone-move-key", store: {} as never, routines: () => null, ownerName: () => "" });

let spies: Array<{ mock: { calls: unknown[][] } }> = [];
beforeEach(() => {
  spies = [
    vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"),
    vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write"),
  ];
});
afterEach(() => vi.restoreAllMocks());

async function fixture(config: CredentialConfig = {}) {
  const material = await keyMaterial();
  let bridge!: PhoneSecretBridge;
  const sent: Array<{ value: string }> = [];
  bridge = new PhoneSecretBridge((message) => {
    sent.push(message);
    queueMicrotask(() => bridge.receive({ type: "openmausbot:phone-secret-save-result", requestId: message.requestId, ok: true }));
    return true;
  }, 200);
  bridge.receive(material.message);
  const opened = vi.spyOn(bridge, "provideMoveKey");
  const handler = createPhoneMoveKeyRoutes({ moving, keys: bridge, config: () => config });
  const fields = (over: Partial<{ deviceId: string; target: string }> = {}) =>
    ({ version: 1 as const, keyId: material.keyId, deviceId: "phone-1", target: "anthropicApiKey", requestKey: "move-key-1", ...over });
  const sealed = (over: Partial<{ deviceId: string; target: string }> = {}) => seal(fields(over), phoneMoveKeyAAD(fields(over)), material.publicKey, KEY);
  const post = async (body: unknown, auth: RequestAuth = GRANT) => {
    const ctx: RouteContext = {
      req: { headers: { "content-type": "application/json" } } as unknown as IncomingMessage, res: {} as ServerResponse,
      path: PATH, method: "POST", url: new URL(PATH, "http://fixture.invalid"), auth,
      readBody: vi.fn(async () => body) as unknown as RouteContext["readBody"], json: vi.fn(),
    };
    await handler(ctx);
    const answer = vi.mocked(ctx.json).mock.calls[0]!;
    return { status: answer[1], body: answer[2] };
  };
  return { post, sealed, sent, opened };
}

describe("POST /api/phone-move/key", () => {
  it("saves a ticked key under the live move grant and never echoes or logs it", async () => {
    const { post, sealed, sent } = await fixture();
    const answer = await post(await sealed());
    expect(answer).toEqual({ status: 200, body: { v: 1, saved: true } });
    expect(sent.map((message) => message.value)).toEqual([KEY]);
    expect(JSON.stringify(answer)).not.toContain(KEY);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  });

  it("refuses a key without a live move grant, before opening it", async () => {
    const { post, sealed, sent, opened } = await fixture();
    const { companionMove: _grant, ...paired } = GRANT as Extract<RequestAuth, { kind: "loopback" }>;
    expect(await post(await sealed(), paired)).toEqual({ status: 403, body: { error: "Allow this move on the computer first." } });
    expect(opened).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses an envelope that is not a sealed key", async () => {
    const { post, sealed, sent, opened } = await fixture();
    expect(await post({ ...await sealed(), threadId: "thread-1" })).toEqual({ status: 400, body: { error: "The encrypted key is invalid" } });
    expect(await post("not an envelope")).toEqual({ status: 400, body: { error: "The encrypted key is invalid" } });
    expect(opened).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses an envelope sealed for another phone", async () => {
    const { post, sealed, sent, opened } = await fixture();
    expect(await post(await sealed({ deviceId: "phone-2" }))).toEqual({ status: 403, body: { error: "This encrypted key belongs to another phone." } });
    expect(opened).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("keeps the computer's own key and says so", async () => {
    const { post, sealed, sent, opened } = await fixture({ anthropic: { key: "sk-ant-here" } });
    expect(await post(await sealed())).toEqual({ status: 200, body: { v: 1, saved: false, kept: true } });
    expect(opened).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses a key the computer keeps elsewhere or does not know", async () => {
    const { post, sealed, sent, opened } = await fixture();
    for (const target of ["onePasswordToken", "geminiApiKey"]) {
      expect(await post(await sealed({ target }))).toEqual({ status: 400, body: { error: "Add this key on the computer." } });
    }
    expect(opened).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses an envelope whose target was swapped in transit", async () => {
    const { post, sealed, sent } = await fixture();
    expect(await post({ ...await sealed(), target: "openaiApiKey" }))
      .toEqual({ status: 400, body: { error: "The encrypted credential could not be verified" } });
    expect(sent).toEqual([]);
  });
});
