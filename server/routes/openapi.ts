// GET /api/openapi.json (and /openapi.json): every HTTP route this server answers, as an OpenAPI 3.0 document.
//
// The list is not written by hand. scripts/route-list.ts reads it out of the code that matches requests (server/index.ts,
// server/routes and the hosts they call) into route-list.generated.ts, and scripts/testing/route-list.test.ts fails when
// that file no longer matches the source, so a route added, moved or removed changes this document in the same pull
// request. A request-path test the reader cannot place fails that test rather than being left out.
//
// What a route entry says, and what it cannot:
//   - the path, as a template (`/api/bots/{botId}`): parameter names come from the code where it names them and from the
//     segment before the slot (`bots` -> `botId`) where a pattern does not;
//   - the methods the handler tests for. One pattern that matches several paths (`(?:\/(rotate|test))?`) lists the union of
//     the methods its handler tests for, so a method may be listed for a path that answers it 405;
//   - `x-openmausbot-match: prefix` where the code matches a path and everything below it (`path.startsWith(...)`); such a
//     path ends in `{rest}`, which may itself hold `/`;
//   - `x-openmausbot-transport: websocket` for paths that accept a WebSocket upgrade, `sse` for a text/event-stream;
//   - `x-openmausbot-methods: any` where the code answers whatever the method (a hosted workspace's 503, a 410 Gone);
//   - `x-openmausbot-source`: the files whose code matches the path.
// Request and response bodies are not described: the handlers validate their own bodies, and nothing declares them.
//
// Access: the same as the other read-only metadata (GET /api/config, /api/today): any signed-in session with the client
// scope, and the loopback owner. It is not public like /api/health: a stranger learns only that this is OpenMausBot.
import { serverVersion } from "../environment.ts";
import { ROUTE_LIST } from "./route-list.generated.ts";
import { PASS, type RouteContext } from "./table.ts";

export const OPENAPI_PATH = "/api/openapi.json";
/** Where FastAPI and most generators publish theirs; the SPA fallback leaves it to this route (static-files.ts). */
export const OPENAPI_ROOT_PATH = "/openapi.json";

export interface RouteListEntry {
  path: string;
  /** Upper-case methods, or ["*"] when the handler answers whatever the method. */
  methods: string[];
  match: "exact" | "prefix";
  pattern?: string;
  transport?: "websocket" | "sse";
  sources: string[];
}

const ALL_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;
type LowerMethod = (typeof ALL_METHODS)[number];

type PathItem = Record<string, unknown>;

/** The OpenAPI path for an entry: a prefix gains a `{rest}` slot for what lies below it. */
export function openApiPath(entry: RouteListEntry): string {
  if (entry.match !== "prefix") return entry.path;
  return entry.path.endsWith("/") ? `${entry.path}{rest}` : `${entry.path}/{rest}`;
}

function describe(entry: RouteListEntry): string {
  let text = "";
  const note = (line: string) => { text = text ? `${text} ${line}` : line; };
  if (entry.match === "prefix") note("Matches this path and every path below it; {rest} may contain /.");
  if (entry.transport === "websocket") note("Accepts a WebSocket upgrade.");
  if (entry.transport === "sse") note("Answers with a text/event-stream (server-sent events).");
  if (entry.methods[0] === "*") note("The handler answers whatever the method.");
  return text;
}

function operation(entry: RouteListEntry, path: string, method: LowerMethod): Record<string, unknown> {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const description = describe(entry);
  return {
    summary: `${method.toUpperCase()} ${path}`,
    ...(description ? { description } : {}),
    ...(names.length ? { parameters: names.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })) } : {}),
    responses: { default: { description: "Answered by the handler at x-openmausbot-source." } },
  };
}

const lowerMethods = (entry: RouteListEntry): readonly LowerMethod[] =>
  entry.methods[0] === "*" ? ALL_METHODS : ALL_METHODS.filter((m) => entry.methods.includes(m.toUpperCase()));

/** The document for a route list. Pure: the route test builds it from a fixture. */
export function openApiDocument(routes: readonly RouteListEntry[], version: string): Record<string, unknown> {
  const paths: Record<string, PathItem> = {};
  for (const entry of routes) {
    const path = openApiPath(entry);
    const item: PathItem = paths[path] ?? {};
    for (const method of lowerMethods(entry)) item[method] = operation(entry, path, method);
    item["x-openmausbot-source"] = [...new Set([...((item["x-openmausbot-source"] as string[] | undefined) ?? []), ...entry.sources])];
    if (entry.match === "prefix") item["x-openmausbot-match"] = "prefix";
    if (entry.pattern) item["x-openmausbot-pattern"] = entry.pattern;
    if (entry.transport) item["x-openmausbot-transport"] = entry.transport;
    if (entry.methods[0] === "*") item["x-openmausbot-methods"] = "any";
    paths[path] = item;
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "OpenMausBot",
      version,
      description: "Every HTTP route this OpenMausBot server answers, read from the code that matches requests (scripts/route-list.ts). "
        + "Any other GET outside /api/ is the web app's page. Request and response bodies are not described.",
    },
    paths,
  };
}

let cached: string | null = null;

/** GET /api/openapi.json and GET /openapi.json. The document is built once, on the first request, and then served as is.
 * A function declaration, not a const: table.ts lists it while this module may still be loading (they import each other). */
export async function openApiRoutes({ res, path, method, json }: RouteContext): Promise<typeof PASS | void> {
  if (path !== OPENAPI_PATH && path !== OPENAPI_ROOT_PATH) return PASS;
  if (method !== "GET") return json(res, 405, { error: "Use GET." });
  cached ??= JSON.stringify(openApiDocument(ROUTE_LIST, serverVersion()));
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
  res.end(cached);
}
