// The web app's own request helper and live events on a relay pairing, against the real `serve --relay` server.
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { waitFor } from "../../companion/test/e2e/wait.ts";
import { startPhoneRelayRig, type PhoneRelayRig } from "../../server/testing/phone-relay-rig.ts";
import { api, ApiError } from "../state/api.ts";
import { fromB64u } from "./e2e/bytes.ts";
import { pairThroughRelay, RelayLink, relayRoute } from "./e2e/relay-link.ts";
import { openLiveEvents } from "./live-events.ts";
import { setRelayLink } from "./relay-server.ts";

let rig: PhoneRelayRig;
let base: string;

beforeAll(async () => {
  rig = await startPhoneRelayRig();
  ({ base } = await rig.boot());
}, 60_000);

afterAll(async () => {
  setRelayLink(null);
  await rig?.close();
});

const owner = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("the web app on a relay pairing", () => {
  it("sends its api requests and opens its live events through the relay", async () => {
    await waitFor(async () => (await owner("/api/auth/pairing")).body.relay?.relay === "connected", 15_000);
    const minted = await owner("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["client"], label: "Web" }) });
    const descriptor = JSON.parse(new TextDecoder().decode(fromB64u(new URL(minted.body.inviteUrl).searchParams.get("e2e")!)!));
    const nodeUrl = () => `${rig.relay.url}/v1/phone`;
    const paired = await waitFor(() => pairThroughRelay(relayRoute(descriptor, { nodeUrl })!, minted.body.credential, "Phone browser").catch(() => null), 8_000);
    setRelayLink(new RelayLink(relayRoute(paired.descriptor, { nodeUrl })!, paired.token));
    onTestFinished(() => setRelayLink(null));

    // Relative paths: with no relay they would have no server to reach in this test.
    const who = await waitFor(() => api<{ kind: string; id: string; scopes: string[] }>("/api/auth/session").catch(() => null), 8_000);
    expect(who).toMatchObject({ kind: "session", scopes: ["client"] });
    expect(await api("/api/bots")).toEqual((await owner("/api/bots")).body);
    const refused = await api("/api/auth/pairing", { method: "POST", body: "{}" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(403);

    let opened = 0;
    let snapshots = 0;
    const stop = openLiveEvents(
      { onOpen: () => (opened += 1), onFrame: () => {}, onSnapshotRequired: async () => ((snapshots += 1), true) },
      { isVisible: () => true, isOnline: () => true },
    );
    onTestFinished(stop);
    // The server's first frame, a fresh `hello`, asks for a snapshot: the stream's events reached the page.
    await waitFor(() => (opened && snapshots ? true : null), 8_000);
    stop();

    expect((await owner(`/api/auth/sessions/${who.id}`, { method: "DELETE" })).status).toBe(200);
  }, 60_000);
});
