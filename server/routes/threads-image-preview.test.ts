import { expect, it, vi } from "vitest";
import { fetchPublicPage } from "../wait-probes.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";
import type { RouteContext } from "./table.ts";

vi.mock("../wait-probes.ts", () => ({ fetchPublicPage: vi.fn() }));

it("serves the referenced public image without requiring CORS and rejects a non-image response", async () => {
  const src = "https://images.example/flower.png";
  const route = createThreadRoutes({
    store: { botByThread: () => ({}), messagesFor: () => [{ id: "m", kind: "text", text: `![flower](${src})` }] },
    viewerFor: () => ({}), visibleTo: () => ({}), workspaceAccess: () => null,
    desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined,
  } as unknown as ThreadRouteDeps);
  const path = "/api/threads/t/messages/m/file";
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const ctx = { method: "GET", path, url: new URL(path + "?preview=1&ref=0", "http://localhost"),
    auth: { kind: "loopback" }, req: { headers: {} }, res, json: vi.fn() } as unknown as RouteContext;
  const response = { ok: true as const, url: new URL(src), headers: { "content-type": "image/png" }, body: Buffer.from("image bytes") };
  vi.mocked(fetchPublicPage).mockResolvedValueOnce(response);
  await route(ctx);
  expect(fetchPublicPage).toHaveBeenCalledWith(src, expect.objectContaining({ maxBytes: expect.any(Number) }));
  expect(res.end).toHaveBeenCalledWith(response.body);
  vi.mocked(fetchPublicPage).mockResolvedValueOnce({ ...response, headers: { "content-type": "text/html" } });
  await route(ctx);
  expect(ctx.json).toHaveBeenCalledWith(res, 415, expect.anything());
});
