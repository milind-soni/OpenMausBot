import { expect, it } from "vitest";
import WebSocket from "ws";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("routes the fixed media upgrade through the real authentication, origin and scope gates", async () => {
  const fixture = await launchVerificationServer();
  const remote = { "x-forwarded-for": "198.51.100.18", "x-forwarded-proto": "https" };
  const mediaUrl = `${fixture.info.url.replace(/^http/, "ws")}/api/live/media`;
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.json() as { code: string }, headers: res.headers };
  };
  const rejectedUpgrade = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(mediaUrl, { headers, handshakeTimeout: 5_000 });
    socket.once("open", () => { socket.close(); reject(new Error("Unauthorized media upgrade was accepted")); });
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.removeListener("error", reject);
      socket.on("error", () => {});
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
  });
  try {
    expect((await api("GET", "/api/live/media")).status).toBe(426);
    expect((await api("GET", "/api/live/media", undefined, remote)).status).toBe(403);
    const pair = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    const paired = await api("POST", "/api/auth/pair", { code: pair.body.code, label: "Qwen media fixture", cookie: true }, remote);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    expect((await api("GET", "/api/live/media", undefined, { ...remote, cookie })).status).toBe(426);
    expect((await api("GET", "/api/live/media", undefined, { ...remote, cookie, origin: "https://attacker.invalid" })).status).toBe(403);
    expect(await rejectedUpgrade(remote)).toBe(403);
    expect(await rejectedUpgrade({ ...remote, cookie, origin: "https://attacker.invalid" })).toBe(403);
    const socket = new WebSocket(mediaUrl, { headers: { ...remote, cookie }, handshakeTimeout: 5_000 });
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "bind", callId: "not-a-running-call" }));
    expect(await closed).toBe(1008);
    console.info(JSON.stringify(fixture.info));
  } finally { await fixture.close(); }
}, 30_000);
