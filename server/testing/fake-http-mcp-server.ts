// A tiny MCP server over HTTP for tests: streamable HTTP by default — the
// answer as plain JSON or as a short event stream — or the older SSE
// transport. It records the headers it saw so a test can prove a token
// arrived, and can hold a request open so a probe's timeout is exercised.
//
// `strictInitialize` makes it behave like a server whose MCP types are
// deserialized strictly (a Java server on Jackson with unknown properties
// failing): an initialize carrying any field outside the 2025-06-18 base
// schema is refused with "Unrecognized field '<name>'", as a
// Voluum server refuses an engine that adds capabilities.elicitation
// .schemaValidation. The spec says unknown fields are ignored; such servers
// do not, and every handshake a client sends is recorded in `initializes`.
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

export interface FakeHttpMcpOptions {
  /** how tools/list answers: a JSON body, or an event stream carrying it */
  answer?: "json" | "event-stream";
  /** serve the older SSE transport instead of streamable HTTP */
  transport?: "http" | "sse";
  /** require this header on every request; anything else gets 401 */
  requireHeader?: { name: string; value: string };
  /** accept a request only when this approves its Authorization header */
  acceptBearer?: (authorization: string | undefined) => boolean;
  /** WWW-Authenticate value sent with a 401 */
  wwwAuthenticate?: string;
  /** never answer tools/list (initialize still works) */
  silentTools?: boolean;
  /** answer tools/list only after this many milliseconds, like a server
   * listing tools for every business an account manages */
  toolsDelayMs?: number;
  description?: string;
  tools?: FakeHttpMcpTool[];
  /** what tools/call answers (default: one "remote execution recorded" text) */
  callResult?: (params: unknown) => unknown;
  /** answer a tools/call with this JSON-RPC error instead, as a strict
   * server reports a bad argument */
  callError?: (params: unknown) => { code: number; message: string } | undefined;
  /** answer each tools/call only after this many milliseconds */
  callDelayMs?: number;
  /** answer each tools/call as an event stream that first says the tool
   * list changed, as a server does after it adds or removes tools */
  listChangedOnCall?: boolean;
  /** the server's own initialize instructions */
  instructions?: string;
  /** answer tools/list in pages of this many tools, with nextCursor */
  pageSize?: number;
  /** with pageSize: hand out the same cursor again and again */
  cursorLoop?: boolean;
  /** during each tools/call, first send the client a request with this
   * method (elicitation/create, sampling/createMessage…) and answer the call
   * only after the client has replied to it */
  askOnCall?: string;
  /** serve https:// with this key and certificate (testing/test-tls.ts) */
  tls?: { key: string; cert: string };
  /** the loopback address to listen on (default 127.0.0.1; "::1" for IPv6) */
  host?: "127.0.0.1" | "::1";
  /** refuse an initialize with any field outside the 2025-06-18 base schema
   * (STRICT_INITIALIZE_FIELDS): "http-400" answers HTTP 400 with a JSON-RPC
   * error, as a Jackson-based streamable HTTP server does on a body it cannot
   * deserialize; "jsonrpc-error" answers HTTP 200 with the error */
  strictInitialize?: "http-400" | "jsonrpc-error";
  /** with strictInitialize: which schema the server knows (default
   * "2025-06-18"). "2025-11-25" also knows elicitation.form/url and the
   * longer clientInfo, yet still not form.schemaValidation, which is where
   * a Voluum server failed */
  strictSchema?: keyof typeof STRICT_INITIALIZE_SCHEMAS;
}

/** The initialize params a strict 2025-06-18 server knows, field by field:
 * an object lists its known fields, `true` is a free-form value (any JSON),
 * and `{}` is an object that must stay empty. */
type FieldShape = true | { [field: string]: FieldShape };
export const STRICT_INITIALIZE_SCHEMAS = {
  "2025-06-18": {
    protocolVersion: true,
    capabilities: {
      roots: { listChanged: true },
      sampling: {},
      elicitation: {},
      experimental: true,
    },
    clientInfo: { name: true, version: true, title: true },
  },
  "2025-11-25": {
    protocolVersion: true,
    capabilities: {
      roots: { listChanged: true },
      sampling: { context: true, tools: true },
      elicitation: { form: {}, url: {} },
      tasks: true,
      experimental: true,
    },
    clientInfo: { name: true, version: true, title: true, description: true, websiteUrl: true, icons: true },
  },
} satisfies Record<string, { [field: string]: FieldShape }>;
export const STRICT_INITIALIZE_FIELDS: { [field: string]: FieldShape } = STRICT_INITIALIZE_SCHEMAS["2025-06-18"];

/** The first field, in document order, a strict server does not know, as a
 * dotted path (capabilities.elicitation.schemaValidation), or undefined. */
export function unrecognizedField(value: unknown, shape: FieldShape = STRICT_INITIALIZE_FIELDS, path = ""): string | undefined {
  if (shape === true || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const [field, inner] of Object.entries(value)) {
    const known = Object.hasOwn(shape, field) ? shape[field] : undefined;
    const at = path ? `${path}.${field}` : field;
    if (known === undefined) return at;
    const deeper = unrecognizedField(inner, known, at);
    if (deeper) return deeper;
  }
  return undefined;
}

export interface FakeHttpMcpTool {
  name: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FakeHttpMcp {
  url: string;
  seenHeaders: IncomingMessage["headers"][];
  calls: unknown[];
  /** tools/list requests now waiting out `toolsDelayMs` */
  readonly delayedToolsLists: number;
  /** tools/list requests answered so far */
  readonly toolsLists: number;
  /** replace the catalog later tools/list requests answer with */
  setTools(tools: FakeHttpMcpTool[]): void;
  /** the client's replies to requests this server sent it */
  replies: unknown[];
  /** the params of every initialize the server received, refused or not */
  initializes: unknown[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

export async function startFakeHttpMcp(options: FakeHttpMcpOptions = {}): Promise<FakeHttpMcp> {
  const transport = options.transport ?? "http";
  const seenHeaders: FakeHttpMcp["seenHeaders"] = [];
  const streams = new Set<ServerResponse>();
  const calls: unknown[] = [];
  let delayedToolsLists = 0;
  let toolsLists = 0;
  let tools = options.tools;
  const replies: unknown[] = [];
  const initializes: unknown[] = [];
  let replied: (() => void) | undefined;
  const ask = () => {
    const waiting = new Promise<void>((resolve) => { replied = resolve; });
    return { waiting, frame: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "server-ask-1", method: options.askOnCall, params: {} })}\n\n` };
  };
  const answerFor = (frame: { id?: unknown; method?: unknown; params?: unknown }) => {
    if (frame.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-http-mcp", version: "1" },
          ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        },
      };
    }
    if (frame.method === "tools/list") {
      toolsLists += 1;
      const all = tools ?? [{ name: "read_notes", description: options.description ?? "Read saved notes" }];
      if (options.pageSize) {
        const cursor = (frame.params as { cursor?: unknown } | undefined)?.cursor;
        const start = typeof cursor === "string" && !options.cursorLoop ? Number(cursor.slice("page-".length)) : 0;
        const end = start + options.pageSize;
        return { jsonrpc: "2.0", id: frame.id, result: {
          tools: all.slice(start, end), ...(end < all.length ? { nextCursor: options.cursorLoop ? "page-again" : `page-${end}` } : {}),
        } };
      }
      return { jsonrpc: "2.0", id: frame.id, result: { tools: all } };
    }
    if (frame.method === "tools/call" && tools) {
      calls.push(frame.params);
      const refused = options.callError?.(frame.params);
      if (refused) return { jsonrpc: "2.0", id: frame.id, error: refused };
      return { jsonrpc: "2.0", id: frame.id, result: options.callResult?.(frame.params) ?? { content: [{ type: "text", text: "remote execution recorded" }] } };
    }
    return null;
  };
  const handle: RequestListener = (req, res) => {
    void (async () => {
      seenHeaders.push({ ...req.headers });
      if ((options.requireHeader && req.headers[options.requireHeader.name.toLowerCase()] !== options.requireHeader.value)
        || (options.acceptBearer && !options.acceptBearer(req.headers.authorization))) {
        res.writeHead(401, {
          "content-type": "application/json",
          ...(options.wwwAuthenticate ? { "www-authenticate": options.wwwAuthenticate } : {}),
        }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (transport === "sse" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("event: endpoint\ndata: /messages\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(req.method === "DELETE" ? 405 : 404).end();
        return;
      }
      const frame = JSON.parse((await readBody(req)) || "{}") as { id?: unknown; method?: unknown; params?: unknown };
      // the client answering a request this server sent it
      if (frame.method === undefined && frame.id !== undefined) {
        replies.push(frame);
        replied?.();
        res.writeHead(202).end();
        return;
      }
      if (frame.method === "initialize") {
        initializes.push(frame.params);
        const field = options.strictInitialize
          ? unrecognizedField(frame.params, STRICT_INITIALIZE_SCHEMAS[options.strictSchema ?? "2025-06-18"])
          : undefined;
        if (field) {
          const name = field.slice(field.lastIndexOf(".") + 1);
          const refusal = JSON.stringify({ jsonrpc: "2.0", id: frame.id ?? null, error: {
            code: -32602,
            message: `Invalid message format: Unrecognized field '${name}' at ${field}, not marked as ignorable`,
          } });
          if (transport === "sse") {
            res.writeHead(202).end();
            for (const stream of streams) stream.write(`event: message\ndata: ${refusal}\n\n`);
            return;
          }
          res.writeHead(options.strictInitialize === "http-400" ? 400 : 200, { "content-type": "application/json" }).end(refusal);
          return;
        }
      }
      // hold the request open: the client's own timeout has to end it
      if (frame.method === "tools/list" && options.silentTools) return;
      if (frame.method === "tools/call" && options.callDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.callDelayMs));
      }
      if (frame.method === "tools/list" && options.toolsDelayMs) {
        const delayed = new Promise((resolve) => setTimeout(resolve, options.toolsDelayMs));
        delayedToolsLists += 1;
        await delayed;
      }
      let answer: object | null = answerFor(frame);
      // a strict server answers a request it does not know, as servers do;
      // the lenient default only accepts it
      if (!answer && options.strictInitialize && typeof frame.method === "string" && frame.id !== undefined) {
        answer = { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } };
      }
      if (!answer) {
        res.writeHead(202).end();
        return;
      }
      if (transport === "sse") {
        res.writeHead(202).end();
        if (options.askOnCall && frame.method === "tools/call") {
          const { waiting, frame: request } = ask();
          for (const stream of streams) stream.write(request);
          await waiting;
        }
        for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
        return;
      }
      const session = { "mcp-session-id": "fake-session" };
      if (options.askOnCall && frame.method === "tools/call") {
        const { waiting, frame: request } = ask();
        res.writeHead(200, { ...session, "content-type": "text/event-stream" });
        res.write(request);
        await waiting;
        res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
        return;
      }
      if (options.listChangedOnCall && frame.method === "tools/call") {
        const changed = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
        res.writeHead(200, { ...session, "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(changed)}\n\nevent: message\ndata: ${JSON.stringify(answer)}\n\n`);
        return;
      }
      if (options.answer === "event-stream" && frame.method === "tools/list") {
        res.writeHead(200, { ...session, "content-type": "text/event-stream" });
        res.end(`: keepalive\n\nevent: message\ndata: ${JSON.stringify(answer)}\n\n`);
        return;
      }
      res.writeHead(200, { ...session, "content-type": "application/json" }).end(JSON.stringify(answer));
    })();
  };
  const server: Server | HttpsServer = options.tls ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handle) : createServer(handle);
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, () => { server.off("error", reject); resolve(); }); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.tls ? "https" : "http"}://${host === "::1" ? "[::1]" : host}:${port}/${transport === "sse" ? "sse" : "mcp"}`,
    seenHeaders,
    calls,
    get delayedToolsLists() { return delayedToolsLists; },
    get toolsLists() { return toolsLists; },
    replies,
    initializes,
    setTools: (next) => { tools = next; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
