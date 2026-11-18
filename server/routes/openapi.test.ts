import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { requiredScope } from "../request-auth.ts";
import { OPENAPI_PATH, OPENAPI_ROOT_PATH, openApiDocument, openApiPath, openApiRoutes, type RouteListEntry } from "./openapi.ts";
import { ROUTE_LIST } from "./route-list.generated.ts";
import { dispatchRoutes, PASS, type RouteContext } from "./table.ts";

type Doc = { openapi: string; info: { version: string }; paths: Record<string, Record<string, any>> };

function context(path: string, method = "GET") {
  const sent: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res = {
    headersSent: false, writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) { sent.status = status; sent.headers = headers; return res; },
    end(body: string) { sent.body = body; res.writableEnded = true; },
  };
  const ctx: RouteContext = {
    req: {} as IncomingMessage, res: res as unknown as ServerResponse, path, method, url: new URL(path, "http://fixture.invalid"),
    auth: { kind: "loopback", scopes: ["admin", "client"] }, readBody: vi.fn(), json: vi.fn(),
  };
  return { ctx, sent };
}

const FIXTURE: RouteListEntry[] = [
  { path: "/api/bots", methods: ["GET", "POST"], match: "exact", sources: ["server/routes/bots-create.ts"] },
  { path: "/api/bots/{botId}/memory/{fileId}", methods: ["PUT"], match: "exact", pattern: "^\\/api\\/bots\\/([\\w-]+)\\/memory\\/([\\w-]+)$", sources: ["server/routes/bot-memory.ts"] },
  { path: "/api/vault/secrets/", methods: ["DELETE"], match: "prefix", sources: ["server/routes/vault.ts"] },
  { path: "/api/cloud-move", methods: ["*"], match: "exact", sources: ["server/cloud-move-http.ts"] },
  { path: "/api/events", methods: ["GET"], match: "exact", transport: "sse", sources: ["server/index.ts"] },
  { path: "/api/usb-phones/{usbPhoneId}/stream", methods: ["GET"], match: "exact", transport: "websocket", sources: ["server/routes/phone-screen.ts"] },
];

describe("openApiDocument", () => {
  const doc = openApiDocument(FIXTURE, "9.9.9") as Doc;

  it("is OpenAPI 3.0 with lower-case methods under templated paths", () => {
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info.version).toBe("9.9.9");
    expect(Object.keys(doc.paths["/api/bots"]!).filter((k) => !k.startsWith("x-"))).toEqual(["get", "post"]);
    expect(doc.paths["/api/bots/{botId}/memory/{fileId}"]!.put.parameters).toEqual([
      { name: "botId", in: "path", required: true, schema: { type: "string" } },
      { name: "fileId", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(doc.paths["/api/bots/{botId}/memory/{fileId}"]!["x-openmausbot-pattern"]).toBe(FIXTURE[1]!.pattern);
  });

  it("says what a template cannot: a prefix, a method-blind handler, a stream", () => {
    const prefix = doc.paths["/api/vault/secrets/{rest}"]!;
    expect(prefix["x-openmausbot-match"]).toBe("prefix");
    expect(prefix.delete.parameters).toEqual([{ name: "rest", in: "path", required: true, schema: { type: "string" } }]);
    const any = doc.paths["/api/cloud-move"]!;
    expect(any["x-openmausbot-methods"]).toBe("any");
    expect(Object.keys(any).filter((k) => !k.startsWith("x-")).sort()).toEqual(["delete", "get", "head", "options", "patch", "post", "put"]);
    expect(doc.paths["/api/events"]!["x-openmausbot-transport"]).toBe("sse");
    expect(doc.paths["/api/events"]!.get.description).toMatch(/event-stream/);
    expect(doc.paths["/api/usb-phones/{usbPhoneId}/stream"]!.get.description).toMatch(/WebSocket/);
  });

  it("gives every operation a response and the files that answer it", () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      expect(item["x-openmausbot-source"], path).not.toHaveLength(0);
      for (const [key, op] of Object.entries(item)) if (!key.startsWith("x-")) expect(op.responses.default, `${key} ${path}`).toBeDefined();
    }
  });
});

describe("the served route list", () => {
  it("answers GET at both paths with every route in the generated list", async () => {
    for (const path of [OPENAPI_PATH, OPENAPI_ROOT_PATH]) {
      const { ctx, sent } = context(path);
      expect(await dispatchRoutes([openApiRoutes], ctx)).toBe(true);
      expect(sent.status).toBe(200);
      expect(sent.headers?.["content-type"]).toMatch(/^application\/json/);
      const doc = JSON.parse(sent.body!) as Doc;
      expect(Object.keys(doc.paths).length).toBe(new Set(ROUTE_LIST.map(openApiPath)).size);
      // The list includes itself, read from this module's own path test.
      expect(doc.paths[OPENAPI_PATH]!.get).toBeDefined();
      expect(doc.paths[OPENAPI_ROOT_PATH]!.get).toBeDefined();
    }
  });

  it("lists routes from index.ts, route modules and the hosts they call", () => {
    const paths = new Set(ROUTE_LIST.map((r) => r.path));
    for (const known of ["/api/health", "/api/bots", "/api/announcements", "/api/sync/folders/{folderId}/files", "/api/events"]) expect(paths, known).toContain(known);
    expect(ROUTE_LIST.find((r) => r.path === "/api/events")?.transport).toBe("sse");
  });

  it("refuses other methods and passes other paths on", async () => {
    const post = context(OPENAPI_PATH, "POST");
    await openApiRoutes(post.ctx);
    expect(post.ctx.json).toHaveBeenCalledWith(post.ctx.res, 405, { error: "Use GET." });
    expect(await openApiRoutes(context("/api/openapi").ctx)).toBe(PASS);
  });

  it("is read-only metadata a client session may read, like /api/config", () => {
    expect(requiredScope("GET", OPENAPI_PATH)).toBe("client");
    expect(requiredScope("GET", OPENAPI_ROOT_PATH)).toBe("client");
    expect(requiredScope("POST", OPENAPI_PATH)).toBe("admin");
  });
});
