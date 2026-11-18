import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { McpOAuthManager, type McpRefreshOutcome } from "./mcp-oauth.ts";
import type { McpOAuthRecord } from "./mcp-oauth-store.ts";

interface PendingRequest {
  path: string;
  form: URLSearchParams;
  response: ServerResponse;
}

let directory: string;
let server: Server;
let endpoint: string;
let manager: McpOAuthManager;
let events: McpRefreshOutcome[];
const resource = "https://docs.example.test/mcp";
let requests: PendingRequest[];
let waiters: Array<(request: PendingRequest) => void>;

function nextRequest(): Promise<PendingRequest> {
  const ready = requests.shift();
  return ready ? Promise.resolve(ready) : new Promise((resolve) => waiters.push(resolve));
}

function reply(request: PendingRequest, status: number, body: unknown): void {
  request.response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function record(label: string, expiresAt = Date.now() - 1, url = resource): McpOAuthRecord {
  return {
    url, state: "signed-in", clientId: "fixture-client", tokenEndpoint: endpoint + "/token", revocationEndpoint: endpoint + "/revoke",
    tokens: { access: `${label}-access`, refresh: `${label}-refresh`, expiresAt },
  };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "mcp-refresh-race-"));
  events = [];
  requests = [];
  waiters = [];
  server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const pending = { path: request.url!, form: new URLSearchParams(body), response };
      const waiter = waiters.shift();
      if (waiter) waiter(pending);
      else requests.push(pending);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  endpoint = `http://127.0.0.1:${address.port}`;
  manager = new McpOAuthManager({ file: join(directory, "oauth.json"), onRefresh: (_name, outcome) => events.push(outcome) });
  manager.adopt("docs", resource, record("old"));
});

afterEach(async () => {
  manager.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

it.each([
  [200, { access_token: "stale-access", refresh_token: "stale-refresh", expires_in: 3600 }],
  [400, { error: "invalid_grant" }],
  [429, { error: "slow_down" }],
] as const)("ignores a %i refresh response after a new sign-in replaces its grant", async (status, body) => {
  const pending = manager.accessToken("docs", resource);
  const request = await nextRequest();
  expect(request.form.get("refresh_token")).toBe("old-refresh");
  const replacement = record("new", Date.now() + 3_600_000);
  manager.adopt("docs", resource, replacement, () => true);
  reply(request, status, body);
  expect(await pending).toBeNull();
  expect(manager.signInRecord("docs", resource)).toEqual(replacement);
  expect(await manager.accessToken("docs", resource)).toBe("new-access");
  expect(events).toEqual([]);
});

it("does not recreate a forgotten entry when its refresh is refused", async () => {
  const pending = manager.accessToken("docs", resource);
  const request = await nextRequest();
  manager.forget("docs");
  reply(request, 400, { error: "invalid_grant" });
  expect(await pending).toBeNull();
  expect(manager.authState("docs", resource)).toBe("none");
  expect(events).toEqual([]);
});

it("refreshes a replacement grant without joining or losing it to the previous request", async () => {
  const oldPending = manager.accessToken("docs", resource);
  const oldRequest = await nextRequest();
  manager.adopt("docs", resource, record("new"), () => true);
  const newPending = manager.accessToken("docs", resource);
  reply(oldRequest, 200, { access_token: "stale-access", expires_in: 3600 });
  expect(await oldPending).toBeNull();
  const newRequest = await nextRequest();
  expect(newRequest.form.get("refresh_token")).toBe("new-refresh");
  const sameGrantPending = manager.accessToken("docs", resource);
  reply(newRequest, 200, { access_token: "new-refreshed", refresh_token: "new-rotated", expires_in: 3600 });
  expect(await newPending).toBe("new-refreshed");
  expect(await sameGrantPending).toBe("new-refreshed");
  expect(requests).toHaveLength(0);
  expect(events).toEqual(["refreshed"]);
});

it("never shares an old refresh with a replacement entry at another resource URL", async () => {
  const oldPending = manager.accessToken("docs", resource);
  const oldRequest = await nextRequest();
  const nextResource = "https://other.example.test/mcp";
  manager.adopt("docs", nextResource, record("other", Date.now() - 1, nextResource));
  const nextPending = manager.accessToken("docs", nextResource);
  let replacementSettled = false;
  void nextPending.then(() => { replacementSettled = true; });
  reply(oldRequest, 200, { access_token: "old-resource-access", expires_in: 3600 });
  expect(await oldPending).toBeNull();
  expect(replacementSettled).toBe(false);
  const next = await nextRequest();
  expect(next.form.get("resource")).toBe(nextResource);
  reply(next, 200, { access_token: "other-access", expires_in: 3600 });
  expect(await nextPending).toBe("other-access");
});

it("signs out immediately and keeps a later sign-in when revocation completes", async () => {
  const signingOut = manager.signOut("docs", resource);
  const revocation = await nextRequest();
  expect(revocation.path).toBe("/revoke");
  expect(revocation.form.get("token")).toBe("old-refresh");
  expect(manager.authState("docs", resource)).toBe("none");
  manager.adopt("docs", resource, record("replacement", Date.now() + 3_600_000));
  reply(revocation, 200, {});
  await signingOut;
  expect(await manager.accessToken("docs", resource)).toBe("replacement-access");
});
