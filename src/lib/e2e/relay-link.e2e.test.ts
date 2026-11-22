// The browser's relay client against the real `serve --relay` server: it pairs with the server's own pairing code, then
// reaches the server's whole request handler, live events included, as a session of its own.
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { waitFor } from "../../../companion/test/e2e/wait.ts";
import { startPhoneRelayRig, type PhoneRelayRig } from "../../../server/testing/phone-relay-rig.ts";
import { fromB64u } from "./bytes.ts";
import { pairThroughRelay, RelayLink, relayRoute } from "./relay-link.ts";

let rig: PhoneRelayRig;
let base: string;

beforeAll(async () => {
  rig = await startPhoneRelayRig();
  ({ base } = await rig.boot());
}, 60_000);

afterAll(async () => {
  await rig?.close();
});

const owner = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const session = (link: RelayLink) => link.fetch("/api/auth/session").then((res) => (res.ok ? (res.json() as Promise<{ id: string }>) : null), () => null);

describe("a web page on MausBot Relay", () => {
  it("pairs through the relay, then reaches the full web server and its live events, and dials again after a drop", async () => {
    await waitFor(async () => (await owner("/api/auth/pairing")).body.relay?.relay === "connected", 15_000);
    const minted = await owner("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["client"], label: "Web" }) });
    const descriptor = JSON.parse(new TextDecoder().decode(fromB64u(new URL(minted.body.inviteUrl).searchParams.get("e2e")!)!));
    const nodeUrl = () => `${rig.relay.url}/v1/phone`;
    const route = relayRoute(descriptor, { nodeUrl });
    expect(route).not.toBeNull();

    const paired = await waitFor(() => pairThroughRelay(route!, minted.body.credential, "Phone browser").catch(() => null), 8_000);
    expect(paired.descriptor).toEqual(descriptor);
    expect(paired.token).toMatch(/^omb_sess_/);
    const link = new RelayLink(relayRoute(paired.descriptor, { nodeUrl })!, paired.token);
    onTestFinished(() => link.close());

    const who = await waitFor(() => session(link), 8_000);
    expect(who).toMatchObject({ kind: "session", scopes: ["client"] });
    // The server's own handler answers, its scope rule included: no companion route list in between.
    expect((await link.fetch("/api/bots")).status).toBe(200);
    expect((await link.fetch("/api/auth/pairing", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);

    const stop = new AbortController();
    const events = await link.fetch("/api/events", { signal: stop.signal });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect((await events.body!.getReader().read()).done).toBe(false);
    stop.abort();

    // The relay drops the session: the next request dials a new one.
    rig.relay.forgeClose(1011);
    expect(await waitFor(() => session(link), 8_000)).toMatchObject({ kind: "session", id: who.id });

    link.close();
    await expect(link.fetch("/api/auth/session")).rejects.toThrow("relay link closed");
    expect((await owner(`/api/auth/sessions/${who.id}`, { method: "DELETE" })).status).toBe(200);
  }, 60_000);
});
