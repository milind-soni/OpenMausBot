import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENTS_DIR } from "../attachments.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(keptAttachments: () => ReadonlySet<string> | null): Promise<string> {
  const deps = { store: new Store(() => sonnet), viewerFor: () => ({}), visibleTo: () => ({ bot: () => true, group: () => true }), workspaceAccess: () => null, desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined, userName: () => "Milind", keptAttachments } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    try {
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("POST /api/attachment-storage", () => {
  // routines.attachmentPaths() is null while routines.json is unreadable or a saved row's attachments are malformed.
  it("deletes nothing while the files to keep are unknown", async () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const file = join(ATTACHMENTS_DIR, "brief.pdf");
    writeFileSync(file, "brief");
    const base = await serve(() => null);

    const cleared = await fetch(`${base}/api/attachment-storage`, { method: "POST" });

    expect([cleared.status, await cleared.text()]).toEqual([503, JSON.stringify({ error: "Routines are still loading. Try again in a moment." })]);
    expect(existsSync(file)).toBe(true);
  });
});
