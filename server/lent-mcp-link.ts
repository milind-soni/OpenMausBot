import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline, Transform } from "node:stream";

import type { LinkStream } from "../electron/device-link-protocol.mjs";
import { LinkEnd } from "./lent-mcp-stdio.ts";

/** Where a request to the door `prefix` goes on the computer's server, or null if the URL is not under the door. */
export function replayPath(url: string, prefix: string, saved: { path: string; query: string }): string | null {
  if (url === prefix || url.startsWith(`${prefix}?`)) return saved.path + saved.query;
  return url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null;
}

/** Re-prefixes the `data:` line of each `event: endpoint` event, whole lines at a time, so the client posts back through the door. */
function endpointRewriter(prefix: string): Transform {
  let held = "";
  let endpoint = false;
  const rewrite = (line: string): string => {
    const text = line.replace(/\r$/, "");
    if (text === "") endpoint = false;
    else if (text.startsWith("event:")) endpoint = text.slice(6).trim() === "endpoint";
    else if (endpoint && text.startsWith("data:")) {
      const url = new URL(text.slice(5).trim(), "http://lent.invalid");
      return `data: ${prefix}${url.pathname}${url.search}${line.endsWith("\r") ? "\r" : ""}`;
    }
    return line;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const lines = (held + chunk.toString()).split("\n");
      held = lines.pop() ?? "";
      done(null, lines.map((line) => `${rewrite(line)}\n`).join(""));
    },
    flush(done) { done(null, held ? rewrite(held) : ""); },
  });
}

/** Replays `req` onto `opened`, a link stream to the computer's server at `target.port`, and streams the answer back.
 * `target.path` is already mapped (see `replayPath`). */
export function replayHttp(
  req: IncomingMessage,
  res: ServerResponse,
  opened: LinkStream,
  target: { port: number; path: string; prefix: string; headers: Record<string, string> },
): void {
  const [ours, theirs] = LinkEnd.pair();
  opened.join(theirs);
  res.once("close", () => { ours.destroy(); theirs.destroy(); });
  // Security: `authorization` is My Cloud's per-turn token for this door; it never leaves My Cloud.
  const { authorization: _turn, host: _host, connection: _connection, ...forwarded } = req.headers;
  const upstream = request({
    createConnection: () => ours,
    method: req.method,
    path: target.path,
    headers: { ...forwarded, ...target.headers, host: `127.0.0.1:${target.port}`, connection: "close" },
  }, (answer) => {
    // Connection: close is this hop's; passed on, it would let a client take a cut-off body for a whole one.
    delete answer.headers.connection;
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    // An SSE stream may stay quiet for long after its headers.
    res.flushHeaders();
    const events = answer.headers["content-type"]?.startsWith("text/event-stream");
    if (events) pipeline(answer, endpointRewriter(target.prefix), res, () => {});
    else pipeline(answer, res, () => {});
  });
  upstream.on("error", () => (res.headersSent || res.destroyed ? res.destroy() : res.writeHead(502).end()));
  req.pipe(upstream);
}
