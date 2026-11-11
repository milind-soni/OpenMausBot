// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { issueMcpCode, registerMcpClient, validateMcpAuthorization } from "./mcp-oauth";
import { signIntegration } from "./integration-bridge";
import { POST as tick } from "../app/api/integrations/tick/route";
import { internal } from "../convex/_generated/api";
import crons from "../convex/crons";
import { convexStore, FIXTURE_INTEGRATION_SECRET, revokedConnectors, seedWorkspace, signedBridge, type Backend } from "../testing/convex-store";

const backend = vi.hoisted(() => ({ current: null as Backend | null }));
const pending = vi.hoisted(() => [] as Promise<unknown>[]);
const sync = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: (task: () => Promise<unknown>) => { pending.push(task()); } }));
vi.mock("./integration-bridge", async importOriginal => ({
  ...await importOriginal<typeof import("./integration-bridge")>(),
  integrationBridge: (operation: string, args: unknown) => operation === "pending" ? Promise.resolve([]) : signedBridge(backend.current!, operation, args),
}));
vi.mock("./github-sync", () => ({ createProjectRepository: sync, syncGitHubPage: sync, syncGitHubOutbox: sync }));
vi.mock("./github-prs", () => ({ syncPRPage: sync }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); pending.length = 0; sync.mockClear(); });

async function signedTick() {
  const body = JSON.stringify({ at: Date.now() });
  const response = await tick(new Request("http://origin.test/api/integrations/tick", { method: "POST", body, headers: { "x-origin-signature": signIntegration(body) } }));
  await Promise.all(pending.splice(0));
  return response;
}

test("abandoned OAuth consents are revoked by a Convex cron, with no frontend request at all", async () => {
  vi.stubEnv("ORIGIN_PUBLIC_URL", "http://origin.test");
  backend.current = convexStore();
  await seedWorkspace(backend.current, ["origin_oauth_abandoned"]);
  const redirect = "http://127.0.0.1:9/callback";
  const client = (await registerMcpClient({ client_name: "Abandoned CLI", redirect_uris: [redirect], token_endpoint_auth_method: "none" }, { key: "register", maximum: 5 })).client_id;
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  await issueMcpCode(await validateMcpAuthorization(new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })), "origin_oauth_abandoned", Date.now() + 86400000, true);

  const maintain = () => backend.current!.run(ctx => ctx.runMutation(internal.mcpOAuth.maintain, {}));
  await maintain();
  expect(await revokedConnectors(backend.current, ["origin_oauth_abandoned"])).toEqual([]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 6 * 60000);
  await maintain();
  expect(await revokedConnectors(backend.current, ["origin_oauth_abandoned"])).toEqual(["origin_oauth_abandoned"]);
  // The cron is registered, so this needs no frontend instance to be alive.
  expect(JSON.stringify(crons)).toContain("mcpOAuth:maintain");
});

test("the signed tick syncs GitHub under a Convex lease that a second instance cannot take", async () => {
  backend.current = convexStore();
  expect((await signedTick()).status).toBe(202);
  expect(sync).toHaveBeenCalled();
  sync.mockClear();
  // Another instance holds the lease: this one reports busy and does no work.
  await signedBridge(backend.current, "store.githubJobLock", { key: "sync-lock" });
  expect(await (await signedTick()).json()).toEqual({ busy: true });
  expect(sync).not.toHaveBeenCalled();
});

test("an unsigned tick is rejected", async () => {
  vi.stubEnv("ORIGIN_INTEGRATION_SECRET", FIXTURE_INTEGRATION_SECRET);
  const response = await tick(new Request("http://origin.test/api/integrations/tick", { method: "POST", body: JSON.stringify({ at: Date.now() }) }));
  expect(response.status).toBe(401);
  expect(pending).toHaveLength(0);
});
