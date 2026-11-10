import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("routes the fixed media upgrade through the real authentication, origin and scope gates", async () => {
  const fixture = await launchVerificationServer();
  const remote = { "x-forwarded-for": "198.51.100.18", "x-forwarded-proto": "https" };
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.json() as { code: string }, headers: res.headers };
  };
  try {
    expect((await api("GET", "/api/live/media")).status).toBe(426);
    expect((await api("GET", "/api/live/media", undefined, remote)).status).toBe(403);
    const pair = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    const paired = await api("POST", "/api/auth/pair", { code: pair.body.code, label: "Qwen media fixture", cookie: true }, remote);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    expect((await api("GET", "/api/live/media", undefined, { ...remote, cookie })).status).toBe(426);
    expect((await api("GET", "/api/live/media", undefined, { ...remote, cookie, origin: "https://attacker.invalid" })).status).toBe(403);
    const socket = new WebSocket(`${fixture.info.url.replace(/^http/, "ws")}/api/live/media`, { headers: { ...remote, cookie } } as unknown as string[]);
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (e) => resolve(e.code)));
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", reject, { once: true }); });
    socket.send(JSON.stringify({ type: "bind", callId: "not-a-running-call" }));
    expect(await closed).toBe(1008);
    console.info(JSON.stringify(fixture.info));
  } finally { await fixture.close(); }
}, 30_000);
