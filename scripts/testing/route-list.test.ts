// The published route list (GET /api/openapi.json) is read from the server's own request matching by scripts/route-list.ts.
// These pin that reader on the shapes the server uses, fail when a request-path test cannot be read, and fail when the
// committed server/routes/route-list.generated.ts is not what the source says today.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLIENT_ALLOW } from "../../server/request-auth.ts";
import { Corpus, extract, loadCorpus, OUTPUT, render, templatesOf } from "../route-list.ts";

const ROOT = new URL("../../", import.meta.url);

/** Routes read from one fixture file, keyed `METHODS path`. */
function routesOf(source: string, extra: Record<string, string> = {}): { routes: string[]; unresolved: string[] } {
  const corpus = new Corpus(new Map([["server/routes/fixture.ts", source], ...Object.entries(extra)]));
  const { routes, unresolved } = extract(corpus);
  return { routes: routes.map((r) => `${r.methods} ${r.path}${r.match === "prefix" ? " (prefix)" : ""}`), unresolved: unresolved.map((u) => u.why) };
}

describe("templatesOf", () => {
  it("names a capture by the segment before it, and keeps literal text around it", () => {
    expect(templatesOf("^\\/api\\/bots\\/([\\w-]+)\\/memory$")).toEqual({ paths: ["/api/bots/{botId}/memory"], prefixes: [] });
    expect(templatesOf("^\\/api\\/team\\/people\\/(p_[\\w-]{22})\\/picture$").paths).toEqual(["/api/team/people/p_{peopleId}/picture"]);
    expect(templatesOf("^\\/api\\/m\\/([0-9a-f]{8}-[0-9a-f]{4})\\/stop$").paths).toEqual(["/api/m/{mId}/stop"]);
    expect(templatesOf("^\\/api\\/instances\\/company\\.([\\w.-]+)$").paths).toEqual(["/api/instances/company.{instanceId}"]);
    expect(templatesOf("^\\/api\\/x\\/(?<item>[\\w-]+)$").paths).toEqual(["/api/x/{item}"]);
  });

  it("expands literal alternatives and optional parts into one path each", () => {
    expect(templatesOf("^\\/api\\/inbox\\/([\\w-]+)\\/(read|done)$").paths).toEqual(["/api/inbox/{inboxId}/read", "/api/inbox/{inboxId}/done"]);
    expect(templatesOf("^\\/api\\/inbox(?:\\/count)?$").paths).toEqual(["/api/inbox/count", "/api/inbox"]);
    expect(templatesOf("^\\/api\\/webhooks\\/([\\w-]+)(?:\\/([\\w-]+))?$").paths).toEqual(["/api/webhooks/{webhookId}/{webhookId2}", "/api/webhooks/{webhookId}"]);
  });

  it("reads `(?:\\/|$)`, an open end and a part that spans `/` as a prefix", () => {
    expect(templatesOf("^\\/api\\/sync\\/folders\\/([\\w-]{1,200})(?:\\/|$)")).toEqual({ paths: [], prefixes: ["/api/sync/folders/{folderId}"] });
    expect(templatesOf("^\\/api\\/bots\\/([\\w-]+)\\/data(?:\\/(.+))?$")).toEqual({ paths: ["/api/bots/{botId}/data"], prefixes: ["/api/bots/{botId}/data/"] });
  });

  it("refuses what is not an anchored path", () => {
    expect(() => templatesOf("\\/api\\/x$")).toThrow(/anchored/);
    expect(() => templatesOf("^(?=x)\\/api$")).toThrow(/lookaround/);
  });
});

describe("extract", () => {
  it("pairs a path with the method tested beside it, around it, or inside what it guards", () => {
    const { routes, unresolved } = routesOf(`
      const ONE = /^\\/api\\/things\\/([\\w-]+)$/;
      export const r = async ({ req, res, path, method, json }) => {
        if (method === "GET" && path === "/api/things") return json(res, 200, []);
        if (path === "/api/things/order") {
          if (method === "PUT") return json(res, 200, {});
          return json(res, 405, {});
        }
        const one = ONE.exec(path);
        if (!one) return PASS;
        if (method !== "DELETE") return json(res, 405, { error: "method not allowed" });
        return json(res, 200, {});
      };`);
    expect(unresolved).toEqual([]);
    expect(routes).toEqual(["GET /api/things", "DELETE /api/things/{thingId}", "PUT /api/things/order"]);
  });

  it("reads an early-return gate, and a prefix gate in front of finer routes is not a route", () => {
    const { routes } = routesOf(`
      export const r = async ({ res, path, method, json }) => {
        if (path !== "/api/vault" && !path.startsWith("/api/vault/")) return PASS;
        if (path === "/api/vault" && method === "GET") return json(res, 200, {});
        if (path !== "/api/vault/lock" || method !== "POST") return PASS;
        return json(res, 200, {});
      };`);
    expect(routes).toEqual(["GET /api/vault", "POST /api/vault/lock"]);
  });

  it("leaves out exclusions and tests that never answer", () => {
    const { routes } = routesOf(`
      export async function handle(req, res) {
        const path = new URL(req.url, "http://x").pathname;
        let counted = false;
        if (path.startsWith("/api/") && path !== "/api/events") counted = true;
        if (req.method === "GET" && path === "/api/health") return json(res, 200, {});
      }`);
    expect(routes).toEqual(["GET /api/health"]);
  });

  it("follows constants across files and the `m = re.exec(path)` reassignments of one variable", () => {
    const { routes, unresolved } = routesOf(`
      import { THINGS } from "./paths.ts";
      export const r = async ({ res, path, method, json }) => {
        let m;
        m = path.match(/^\\/api\\/a\\/([\\w-]+)$/);
        if (m && method === "GET") return json(res, 200, {});
        m = path.match(/^\\/api\\/b\\/([\\w-]+)$/);
        if (m && method === "POST") return json(res, 200, {});
        if (path === \`\${THINGS}/count\` && method === "GET") return json(res, 200, 0);
      };`, { "server/routes/paths.ts": 'export const THINGS = "/api/things";' });
    expect(unresolved).toEqual([]);
    expect(routes).toEqual(["GET /api/a/{aId}", "POST /api/b/{bId}", "GET /api/things/count"]);
  });

  it("marks a handler that answers whatever the method", () => {
    expect(routesOf(`export const r = async ({ res, path }) => { if (path === "/api/gone") { res.writeHead(410); res.end(); return true; } };`).routes)
      .toEqual(["* /api/gone"]);
  });

  it("does not read a path variable that is not the request's", () => {
    expect(routesOf(`export function f(path: string) { if (path === "/etc/hosts") return 1; }`).routes).toEqual([]);
  });

  it("reads a predicate the request path is handed to, and fails closed on one it cannot open", () => {
    const { routes, unresolved } = routesOf(`
      import { isLentPath } from "./lent.ts";
      export const r = async ({ res, path, method, json }) => {
        if (method === "POST" && isLentPath(path)) return json(res, 200, {});
        if (isLongPollPath(path)) return json(res, 200, {});
        if (deps.mystery(path)) return json(res, 200, {});
      };`, { "server/routes/lent.ts": 'export const isLentPath = (path: string) => path.startsWith("/api/internal/lent/");' });
    expect(routes).toEqual(["POST /api/internal/lent/ (prefix)"]);
    expect(unresolved).toEqual(["hands the request path to deps.mystery, which the reader cannot follow"]);
  });

  it("knows a request context by what it holds, and a path cut from req.url", () => {
    const { routes } = routesOf(`
      export function host() {
        return { async internal(args: { path: string; method: string; res: unknown }) {
          if (args.path !== "/api/internal/reset") return PASS;
          if (args.method !== "POST") return void args.json(args.res, 405, {});
          return void args.json(args.res, 200, {});
        } };
      }
      export function relay(req, res) {
        const path = (req.url ?? "/").split("?")[0];
        if (req.method === "GET" && path === "/api/companion/endpoints") return reply(res, 200, {});
      }
      const rows = [{ method: "GET", path: "/x" }];
      export const allowed = (method, path) => rows.some((row) => row.method === method && row.path === path);`);
    expect(routes).toEqual(["GET /api/companion/endpoints", "POST /api/internal/reset"]);
  });

  it("keeps a path whose gate re-tests it only to pick a value", () => {
    const { routes } = routesOf(`
      export const r = async (ctx) => {
        if (!((ctx.method === "GET" && ctx.path === "/api/n") || (ctx.method === "POST" && ctx.path === "/api/n/read"))) return PASS;
        let result;
        if (ctx.path === "/api/n") result = list();
        else result = read();
        return ctx.json(ctx.res, 200, result);
      };`);
    expect(routes).toEqual(["GET /api/n", "POST /api/n/read"]);
  });

  it("fails closed on a request-path test it cannot read", () => {
    const { routes, unresolved } = routesOf(`
      export const r = async ({ res, path, method, json }) => {
        if (path === someRuntimeValue()) return json(res, 200, {});
      };`);
    expect(routes).toEqual([]);
    expect(unresolved).toEqual(["compared with something that is not a literal"]);
  });
});

describe("the server's route list", () => {
  const { routes, unresolved } = extract(loadCorpus());

  it("reads every request-path test in the server", () => {
    expect(unresolved.map((u) => `${u.source}: ${u.why}: ${u.text}`), "teach scripts/route-list.ts this shape, or write the test as one it reads").toEqual([]);
  });

  it("is what server/routes/route-list.generated.ts holds", () => {
    const committed = readFileSync(new URL(OUTPUT, ROOT), "utf8");
    expect(committed === render(routes), "run: pnpm routes:list").toBe(true);
  });

  it("covers every path request-auth.ts lets a client session use", () => {
    // Both sides as shapes, parameters blank: the rule's own pattern read the way a handler's is.
    const shape = (path: string) => path.replace(/\{[^}]+\}/g, "{}");
    const listed = routes.map((r) => ({ shape: shape(r.path), prefix: r.match === "prefix" }));
    const uncovered = CLIENT_ALLOW.flatMap((rule) => {
      const { paths, prefixes } = templatesOf(rule.path.source);
      return [...paths, ...prefixes].map(shape).filter((wanted) => !listed.some((r) => (r.prefix ? wanted.startsWith(r.shape) : wanted === r.shape)));
    });
    expect(uncovered).toEqual([]);
  });
});
