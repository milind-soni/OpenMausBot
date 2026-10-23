import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";

it("keeps resolved endpoint and capacity settings admin-only in config responses and events", async () => {
  const fixture = await launchVerificationServer();
  const remote = { "x-forwarded-for": "198.51.100.18", "x-forwarded-proto": "https" };
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };
  const pair = async (scopes: string[]) => {
    const opened = await api("POST", "/api/auth/pairing", { scopes });
    const paired = await api("POST", "/api/auth/pair", { code: opened.code, label: "Endpoint privacy fixture" }, remote);
    return { ...remote, authorization: `Bearer ${paired.token}` };
  };
  const endpoint = "http://127.0.0.1:1/v1";
  const canary = "http://endpoint-capacity-canary.invalid/private/v1";
  let memberEvents: Awaited<ReturnType<typeof openSse>> | undefined;
  let adminEvents: Awaited<ReturnType<typeof openSse>> | undefined;
  try {
    const member = await pair(["client"]), admin = await pair(["admin", "client"]);
    await api("PATCH", "/api/config", { openaiCompat: { url: endpoint, contextWindows: { [endpoint]: { fixture: 8192 }, [canary]: { private: 65536 } } } });
    const owner = (await api("GET", "/api/config", undefined, admin)).openaiCompat;
    expect(owner).toMatchObject({ url: endpoint, resolvedUrl: endpoint, contextWindows: { [endpoint]: { fixture: 8192 } } });
    const client = (await api("GET", "/api/config", undefined, member)).openaiCompat;
    expect(JSON.stringify(client)).not.toContain(canary);
    expect(client).toEqual({ configured: owner.configured, url: endpoint });
    memberEvents = await openSse(`${fixture.info.url}/api/events`, member);
    adminEvents = await openSse(`${fixture.info.url}/api/events`, admin);
    const hello = await memberEvents.until(frame => frame.kind === "hello");
    await api("PATCH", "/api/config", { openaiCompat: { contextWindows: { [endpoint]: { fixture: 16384 } } } });
    const [m, a] = await Promise.all([memberEvents.until(frame => frame.kind === "config"), adminEvents.until(frame => frame.kind === "config")]);
    expect(m.openaiCompat).toEqual({ configured: owner.configured, url: endpoint });
    expect(a.openaiCompat).toMatchObject({ resolvedUrl: endpoint, contextWindows: { [endpoint]: { fixture: 16384 } } });
    expect(JSON.stringify(m)).not.toContain(canary);
    memberEvents.close();
    memberEvents = await openSse(`${fixture.info.url}/api/events?since=${encodeURIComponent(hello.cursor)}`, member);
    expect(await memberEvents.until(frame => frame.kind === "hello")).toMatchObject({ resumed: true });
    const replayed = await memberEvents.until(frame => frame.kind === "config");
    expect(replayed.openaiCompat).toEqual({ configured: owner.configured, url: endpoint });
    expect(JSON.stringify(replayed)).not.toContain(canary);
  } finally { memberEvents?.close(); adminEvents?.close(); await fixture.close(); }
}, 60_000);
