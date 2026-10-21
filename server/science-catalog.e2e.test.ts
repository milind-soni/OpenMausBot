// End-to-end coverage for MausBot Cloud connectors on a real server: the relay token is injected at the sign-in seam
// and never appears in config, logs or responses. One loopback stand-in plays the science relay.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { startFakeScienceRelay, type FakeScienceRelay } from "./testing/fake-science-relay.ts";

const TOKEN = `omb_sd_${"e2e".padEnd(43, "x")}`;
let relay: FakeScienceRelay;
let session: Awaited<ReturnType<typeof launchVerificationServer>>;
const api = (method: string, path: string, body?: unknown) =>
  request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session.info.url) as Promise<any>;

describe("science catalog connectors", () => {
  beforeAll(async () => {
    relay = await startFakeScienceRelay({ token: TOKEN });
    session = await launchVerificationServer({ ...process.env, OMB_CLOUD_SCIENCE_URL: relay.base, OMB_CLOUD_SCIENCE_TOKEN: TOKEN });
  });
  afterAll(async () => {
    await session?.close();
    await relay?.close();
  });

  it("connects a public database through the relay without the token leaving the server", async () => {
    const catalog = await api("GET", "/api/connector-catalog");
    expect(catalog).toMatchObject({ served: true, catalog: { sections: [{ locked: false }] } });
    expect(catalog.catalog.sections[0].entries.find((e: { id: string }) => e.id === "pubmed")).toMatchObject({ auth: "cloud" });
    const url = `${relay.base}/pubmed/mcp`;
    await api("POST", "/api/mcp/servers", { name: "pubmed", type: "http", url, enabled: false, catalog: { id: "pubmed", auth: "cloud" } });
    expect(await api("POST", "/api/mcp/servers/pubmed/test")).toMatchObject({ ok: true });
    expect(relay.authorizations).toContain(`Bearer ${TOKEN}`);
    const listed = await api("GET", "/api/mcp/servers");
    expect(listed.servers.find((s: { name: string }) => s.name === "pubmed")).toMatchObject({ auth: "signed-in", catalog: { id: "pubmed", auth: "cloud" } });
    for (const text of [JSON.stringify(listed), readFileSync(join(session.info.dataDir, "config.json"), "utf8"), readFileSync(session.info.logPath, "utf8")]) {
      expect(text).not.toContain(TOKEN);
    }
    await expect(api("POST", "/api/mcp/servers/pubmed/sign-in")).rejects.toThrow(/need no sign-in/);
  });

  it("a relay refusal after Max ends leaves the entry stored and not needing sign-in", async () => {
    relay.setLocked(true);
    expect(await api("POST", "/api/mcp/servers/pubmed/test")).toMatchObject({ ok: false, status: 402 });
    expect((await api("GET", "/api/mcp/servers")).servers.find((s: { name: string }) => s.name === "pubmed")).toMatchObject({ auth: "signed-in" });
  });
});
