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

it("never presents a refresh token it already sent, so a rotating server does not revoke the grant", async () => {
  // The server rotates the token but its answer is lost. The client must not present that token again: a server
  // that rotates refresh tokens revokes the whole grant when it sees one of them a second time.
  const first = manager.accessToken("docs", resource);
  const request = await nextRequest();
  expect(request.form.get("refresh_token")).toBe("old-refresh");
  request.response.destroy();
  await first.catch(() => undefined);
  expect(requests).toHaveLength(0);

  // The next attempt must not send the same refresh token again.
  const second = manager.accessToken("docs", resource);
  await second.catch(() => undefined);
  expect(requests).toHaveLength(0);
  expect(manager.authState("docs", resource)).toBe("needs-sign-in");
});

it("does not present a spent refresh token again after a restart", async () => {
  // The mark of a spent token lives in the store, not in memory: a manager that starts again reads it from the file
  // and must not present that token, or a rotating server revokes the grant.
  const first = manager.accessToken("docs", resource);
  const request = await nextRequest();
  expect(request.form.get("refresh_token")).toBe("old-refresh");
  request.response.destroy();
  await first.catch(() => undefined);

  const restarted = new McpOAuthManager({ file: join(directory, "oauth.json") });
  try {
    const second = restarted.accessToken("docs", resource);
    await second.catch(() => undefined);
    expect(requests).toHaveLength(0);
    expect(restarted.authState("docs", resource)).toBe("needs-sign-in");
  } finally {
    restarted.dispose();
  }
});

it("presents the refresh token again when nothing reached the server", async () => {
  // Offline, or the address does not answer: the request never left, so the token was not spent and the sign-in stays.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  manager.adopt("docs", resource, { ...record("old"), tokenEndpoint: `http://127.0.0.1:${port}/token` }, () => true);
  expect(await manager.accessToken("docs", resource)).toBeNull();
  expect(await manager.accessToken("docs", resource)).toBeNull();
  expect(events).toEqual(["unreachable", "unreachable"]);
  expect(manager.authState("docs", resource)).not.toBe("needs-sign-in");
});

it("presents the refresh token again after the server answered without one", async () => {
  // A busy or rate-limited server issued nothing, so the next renewal sends the same token.
  const first = manager.accessToken("docs", resource);
  const request = await nextRequest();
  reply(request, 503, { error: "temporarily_unavailable" });
  expect(await first).toBeNull();
  const second = manager.accessToken("docs", resource);
  const again = await nextRequest();
  expect(again.form.get("refresh_token")).toBe("old-refresh");
  reply(again, 200, { access_token: "fresh-access", refresh_token: "new-refresh" });
  expect(await second).toBe("fresh-access");
});

it("presents the refresh token again when the server kept it", async () => {
  // A server that does not rotate refresh tokens answers without a new one, and the old token stays valid
  // (RFC 6749 section 6). The next renewal has to present it again, so the mark of a spent token is cleared when
  // the server answers and keeps that same token.
  const first = manager.accessToken("docs", resource);
  const request = await nextRequest();
  expect(request.form.get("refresh_token")).toBe("old-refresh");
  reply(request, 200, { access_token: "first-access" });
  expect(await first).toBe("first-access");

  // The server refused the access token, so the grant is renewed: the refresh token is presented again.
  const refused = manager.tokenRefused("docs", resource);
  const again = await nextRequest();
  expect(again.form.get("refresh_token")).toBe("old-refresh");
  reply(again, 200, { access_token: "second-access" });
  expect(await refused).toBe("refreshed");
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
