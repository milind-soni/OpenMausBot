import { describe, expect, it } from "vitest";

import { GROK_LINK_ATTACH_PATH, GROK_LINK_BODY_MAX, GROK_LINK_PATH_PREFIX, GROK_LINK_SECRET_HEADER, linkKey, type LinkManifest, type LinkSecret } from "../../../shared/grok-link";
import { DAY_MS, sha256 } from "./common";
import { redactPath } from "./grok-link";
import worker from "./index";
import { brokerHarness, FAKE_GROK_LINK_ATTACHED } from "./test-harness";

const SECRET = "s".repeat(43) as LinkSecret;
const OTHER = "o".repeat(43) as LinkSecret;
const told = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });
const MANIFEST: LinkManifest = { versions: ["2025-06-18"], initialize: { serverInfo: { name: "MausBot" } }, tools: { tools: [{ name: "move_status" }] }, offline: told("closed"), late: told("late") };
const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });

function linkHarness() {
  const harness = brokerHarness();
  const upgrade = (secret: string | null, init: RequestInit = {}) => harness.fetch(GROK_LINK_ATTACH_PATH, {
    ...init, headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.7", ...(secret ? { [GROK_LINK_SECRET_HEADER]: secret } : {}) },
  });
  /** A desktop as the service sees it: the upgrade, then its socket in the link's object, saying hello. */
  const desktop = async (secret: LinkSecret) => {
    const response = await upgrade(secret);
    expect(response.status).toBe(200);
    const sent: Array<{ t: string; id: string; message: { id: number } }> = [];
    const state = { closedWith: undefined as number | undefined };
    const socket = harness.grokLinks.attach(response.headers.get(FAKE_GROK_LINK_ATTACHED)!, { send: (text) => { sent.push(JSON.parse(text)); }, close: (code) => { state.closedWith = code; } });
    await socket.received(JSON.stringify({ t: "hello", manifest: MANIFEST }));
    return { sent, state, socket };
  };
  const address = async (secret: LinkSecret) => `${GROK_LINK_PATH_PREFIX}${await linkKey(secret)}`;
  const post = (path: string, body: BodyInit, headers: Record<string, string> = { "content-type": "application/json" }) => harness.fetch(path, { method: "POST", headers, body });
  const rows = () => harness.d1.rows<{ key_hash: string; created_at: number; attached_at: number }>("SELECT * FROM grok_links");
  return { harness, upgrade, desktop, address, post, rows };
}

describe("the Grok Bot link on the connected-apps service", () => {
  it("makes a link when a desktop attaches with a secret, and keeps neither the secret nor the address", async () => {
    const { desktop, address, post, rows, harness } = linkHarness();
    await desktop(SECRET);
    const path = await address(SECRET);
    expect(rows()).toEqual([{ key_hash: await sha256(path.slice(GROK_LINK_PATH_PREFIX.length)), created_at: expect.any(Number), attached_at: expect.any(Number) }]);
    expect(harness.grokLinks.made()).toEqual([rows()[0]!.key_hash]);
    expect(JSON.stringify(rows())).not.toContain(SECRET);
    const listed = await post(path, rpc("tools/list"));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ jsonrpc: "2.0", id: 1, result: MANIFEST.tools });
  });

  it("relays a tool call to the attached desktop and answers offline once it is gone", async () => {
    const { desktop, address, post } = linkHarness();
    const { sent, socket } = await desktop(SECRET);
    const path = await address(SECRET);
    const answer = post(path, rpc("tools/call", { name: "move_status" }));
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ t: "call", message: { id: 1, method: "tools/call" } });
    await socket.received(JSON.stringify({ t: "answer", id: sent[0]!.id, status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [] } } }));
    expect(await (await answer).json()).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    socket.closed();
    expect(await (await post(path, rpc("tools/call", { name: "move_status" }))).json()).toEqual({ jsonrpc: "2.0", id: 1, result: MANIFEST.offline });
    expect((await (await post(path, rpc("initialize"))).json() as { result: unknown }).result).toMatchObject({ protocolVersion: "2025-06-18" });
  });

  it("keeps the address when the same secret attaches again, and never counts that as a new link", async () => {
    const { desktop, rows, harness } = linkHarness();
    const first = await desktop(SECRET);
    const [made] = rows();
    harness.limits.registration = false;
    harness.env.REGISTRATION_MODE = "closed";
    await desktop(SECRET);
    expect(first.state.closedWith, "the older socket is replaced").toBe(4001);
    expect(rows()).toEqual([{ ...made, attached_at: expect.any(Number) }]);
  });

  it("refuses a new link while registration is closed or its maker made too many, and anything without a secret", async () => {
    const { upgrade, rows, harness } = linkHarness();
    for (const secret of [null, "short", `${SECRET}x`]) expect((await upgrade(secret)).status, String(secret)).toBe(401);
    harness.limits.registration = false;
    expect((await upgrade(SECRET)).status).toBe(429);
    harness.limits.registration = true;
    harness.env.REGISTRATION_MODE = "closed";
    expect((await upgrade(SECRET)).status).toBe(503);
    expect((await harness.fetch(GROK_LINK_ATTACH_PATH, { headers: { [GROK_LINK_SECRET_HEADER]: SECRET } })).status, "not an upgrade").toBe(405);
    expect(rows()).toEqual([]);
    expect(harness.grokLinks.made()).toEqual([]);
  });

  it("answers an address that is not a link 404 without making an object, and lets the address attach nothing", async () => {
    const { desktop, address, post, upgrade, harness } = linkHarness();
    await desktop(SECRET);
    const made = harness.grokLinks.made();
    const unknown = await address(OTHER);
    expect((await post(unknown, rpc("tools/list"))).status).toBe(404);
    expect((await post(`${GROK_LINK_PATH_PREFIX}short`, rpc("tools/list"))).status).toBe(404);
    expect(harness.grokLinks.made()).toEqual(made);
    const key = (await address(SECRET)).slice(GROK_LINK_PATH_PREFIX.length);
    expect((await upgrade(key)).status, "the address's key is a secret of its own, never this link's").toBe(200);
    expect(harness.d1.rows("SELECT * FROM grok_links")).toHaveLength(2);
  });

  it("takes only a JSON POST of at most 4 MB and an envelope, 60 a minute per link", async () => {
    const { desktop, address, post, harness } = linkHarness();
    const { sent, socket } = await desktop(SECRET);
    const path = await address(SECRET);
    expect((await harness.fetch(path)).status).toBe(405);
    expect((await harness.fetch(path)).headers.get("allow")).toBe("POST");
    expect((await post(path, rpc("tools/list"), { "content-type": "text/plain" })).status).toBe(415);
    const tooBig = await post(path, new Uint8Array(GROK_LINK_BODY_MAX + 1).fill(0x20));
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json() as { error: { message: string } }).error.message).toContain("larger than 4 MB");
    const whole = rpc("tools/call", { name: "send_export", arguments: { document: "x".repeat(4 * 1024 * 1024) } });
    const answer = post(path, whole);
    await expect.poll(() => sent.length).toBe(1);
    expect(JSON.stringify(sent[0]!.message)).toHaveLength(whole.length);
    await socket.received(JSON.stringify({ t: "answer", id: sent[0]!.id, status: 200, body: {} }));
    expect((await answer).status).toBe(200);
    harness.limits.link = false;
    expect((await post(path, rpc("tools/list"))).status).toBe(429);
  });

  it("turns a link off for the holder of its secret only: the row and the object's manifest go and the socket closes", async () => {
    const { desktop, address, post, rows, harness } = linkHarness();
    const { state } = await desktop(SECRET);
    const path = await address(SECRET);
    const off = (secret: string) => harness.fetch(GROK_LINK_ATTACH_PATH, { method: "DELETE", headers: { [GROK_LINK_SECRET_HEADER]: secret } });
    expect((await off(path.slice(GROK_LINK_PATH_PREFIX.length))).status).toBe(204);
    expect(rows()).toHaveLength(1);
    expect(state.closedWith).toBeUndefined();
    expect((await off(SECRET)).status).toBe(204);
    expect(rows()).toEqual([]);
    expect(state.closedWith).toBe(4004);
    expect((await post(path, rpc("tools/list"))).status).toBe(404);
    expect((await off(SECRET)).status, "again").toBe(204);
  });

  it("sweeps a link no desktop attached to for 30 days, and gives the same address back when that desktop returns", async () => {
    const { desktop, address, post, rows, harness } = linkHarness();
    const old = await desktop(SECRET);
    await desktop(OTHER);
    const path = await address(SECRET);
    const [swept] = rows();
    harness.d1.db.prepare("UPDATE grok_links SET attached_at = ? WHERE key_hash = ?").run(Date.now() - 31 * DAY_MS, swept!.key_hash);
    await worker.scheduled({ scheduledTime: Date.now() } as never, harness.env as never);
    expect(rows().map((row) => row.key_hash)).not.toContain(swept!.key_hash);
    expect(rows()).toHaveLength(1);
    expect(old.state.closedWith, "a desktop still attached is sent to attach again").toBe(4004);
    expect((await post(path, rpc("tools/list"))).status).toBe(404);
    await desktop(SECRET);
    expect(rows().map((row) => row.key_hash)).toContain(swept!.key_hash);
    expect((await post(path, rpc("tools/list"))).status).toBe(200);
  });

  it("keeps a link's key out of the error log", () => {
    expect(redactPath(`${GROK_LINK_PATH_PREFIX}${"k".repeat(43)}`)).toBe("/mcp/move/[key]");
    expect(redactPath("/v1/me")).toBe("/v1/me");
  });
});
