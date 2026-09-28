// A tiny MCP server over HTTP for tests: streamable HTTP by default — the
// answer as plain JSON or as a short event stream — or the older SSE
// transport. It records the headers it saw so a test can prove a token
// arrived, and can hold a request open so a probe's timeout is exercised.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeHttpMcpOptions {
  /** how tools/list answers: a JSON body, or an event stream carrying it */
  answer?: "json" | "event-stream";
  /** serve the older SSE transport instead of streamable HTTP */
  transport?: "http" | "sse";
  /** require this header on every request; anything else gets 401 */
  requireHeader?: { name: string; value: string };
  /** never answer tools/list (initialize still works) */
  silentTools?: boolean;
  description?: string;
}

export interface FakeHttpMcp {
  url: string;
  seenHeaders: IncomingMessage["headers"][];
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
  const answerFor = (frame: { id?: unknown; method?: unknown }) => {
    if (frame.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: frame.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-http-mcp", version: "1" } },
      };
    }
    if (frame.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: frame.id,
        result: { tools: [{ name: "read_notes", description: options.description ?? "Read saved notes" }] },
      };
    }
    return null;
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      seenHeaders.push({ ...req.headers });
      if (options.requireHeader && req.headers[options.requireHeader.name.toLowerCase()] !== options.requireHeader.value) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
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
      const frame = JSON.parse((await readBody(req)) || "{}") as { id?: unknown; method?: unknown };
      // hold the request open: the client's own timeout has to end it
      if (frame.method === "tools/list" && options.silentTools) return;
      const answer = answerFor(frame);
      if (!answer) {
        res.writeHead(202).end();
        return;
      }
      if (transport === "sse") {
        res.writeHead(202).end();
        for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
        return;
      }
      const session = { "mcp-session-id": "fake-session" };
      if (options.answer === "event-stream" && frame.method === "tools/list") {
        res.writeHead(200, { ...session, "content-type": "text/event-stream" });
        res.end(`: keepalive\n\nevent: message\ndata: ${JSON.stringify(answer)}\n\n`);
        return;
      }
      res.writeHead(200, { ...session, "content-type": "application/json" }).end(JSON.stringify(answer));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${transport === "sse" ? "sse" : "mcp"}`,
    seenHeaders,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
