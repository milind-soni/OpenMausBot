// With OMB_COMPOSIO_API naming a backend (a loopback stand-in in fixtures), the saved project key reaches that backend
// only: every Composio call the own-key path makes, the toolkit listing included, goes there and none to composio.dev.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as composio from "./composio.ts";
import type { AppConfig } from "./config.ts";
import { startFakeComposioProject, type FakeComposioProject } from "./testing/fake-composio-project.ts";

const KEY = "ak_fixture_only_key";
const cfg = { composio: { apiKey: KEY, userId: "openmausbot_fixture" } } as AppConfig;

let project: FakeComposioProject;
let fetched: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => { project = await startFakeComposioProject(KEY); });
afterAll(async () => { await project.close(); });

beforeEach(() => {
  fetched = [];
  project.requests.length = 0;
  vi.stubEnv("OMB_COMPOSIO_API", project.api);
  vi.stubEnv("OMB_COMPOSIO_TOOLKITS_API", undefined);
  vi.stubEnv("OMB_COMPOSIO_BROKER_URL", undefined);
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return realFetch(input, init);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const composioHosts = () => fetched.filter((url) => /^https?:\/\/([^/]*\.)?composio\.dev(?=[/:]|$)/.test(url));

describe("own Composio backend", () => {
  it("lists toolkits from the named backend, not from Composio", async () => {
    const listing = await composio.listToolkits(cfg);
    expect(listing.source).toBe("api");
    expect(listing.cards.map((card) => card.slug)).toEqual(expect.arrayContaining(["gmail", "slack", "github"]));
    expect(project.requests).toContainEqual(expect.objectContaining({ method: "GET", path: "/api/v3/toolkits", apiKey: KEY }));
    expect(fetched.length).toBeGreaterThan(0);
    expect(composioHosts()).toEqual([]);
  });

  it("connects, lists and removes an account through the named backend only", async () => {
    await expect(composio.authorizeService(cfg, "gmail", "work")).resolves.toHaveProperty("url");
    const account = project.connect("openmausbot_fixture", "gmail");
    await expect(composio.connectedServices(cfg)).resolves.toHaveProperty("gmail.connected", true);
    await expect(composio.removeAccount(cfg, "gmail", account)).resolves.toEqual({ removed: 1 });
    expect(fetched.every((url) => url.startsWith(project.origin))).toBe(true);
    expect(composioHosts()).toEqual([]);
  });
});
