// A stand-in for the science catalog relay: `GET {base}/catalog` and `{base}/{id}/mcp`, answered only for its bearer
// token. While locked it serves the locked teaser and answers every MCP call 402 `subscription_inactive`.
// Run directly it prints the env that points a server at it; `--locked` starts it locked.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { SCIENCE_TEASER, type CatalogResponse } from "../../shared/connector-catalog.ts";
import { startFakeHttpMcp } from "./fake-http-mcp-server.ts";

export interface FakeScienceRelay {
  /** `http://127.0.0.1:{port}/api/cloud/services/science` */
  base: string;
  /** The Authorization header of every request, in order. */
  authorizations: string[];
  setLocked(locked: boolean): void;
  close(): Promise<void>;
}

const BASE_PATH = "/api/cloud/services/science";

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeScienceRelay(options: { token: string; locked?: boolean }): Promise<FakeScienceRelay> {
  let locked = options.locked ?? false;
  const authorizations: string[] = [];
  const upstream = await startFakeHttpMcp();
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const authorization = req.headers.authorization;
    authorizations.push(authorization ?? "");
    const path = req.url ?? "";
    if (!path.startsWith(`${BASE_PATH}/`)) return send(404, { error: "not_found" });
    if (authorization !== `Bearer ${options.token}`) return send(401, { error: "unauthorized" });
    const rest = path.slice(BASE_PATH.length);
    if (rest === "/catalog" && req.method === "GET") {
      const [section] = SCIENCE_TEASER.sections;
      const catalog: CatalogResponse = {
        version: 1,
        sections: [{
          ...section!,
          locked,
          // The shared parser drops an entry whose address is not https, and this stand-in is plain http on loopback.
          entries: section!.entries.map((entry) => (!locked && entry.auth === "cloud" && base.startsWith("https:") ? { ...entry, url: `${base}/${entry.id}/mcp` } : entry)),
        }],
      };
      return send(200, catalog);
    }
    if (!/^\/[a-z][a-z0-9-]*\/mcp$/.test(rest)) return send(404, { error: "not_found" });
    if (locked) return send(402, { error: "subscription_inactive" });
    const body = await readBody(req);
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const forwarded = await fetch(upstream.url, { method: req.method, headers, ...(body.length ? { body } : {}) });
    const out: Record<string, string> = {};
    forwarded.headers.forEach((value, key) => {
      if (["content-type", "mcp-session-id"].includes(key)) out[key] = value;
    });
    res.writeHead(forwarded.status, out);
    res.end(Buffer.from(await forwarded.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE_PATH}`;
  return {
    base,
    authorizations,
    setLocked: (value) => { locked = value; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await upstream.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = `omb_sd_${"fixture".padEnd(43, "x")}`;
  const relay = await startFakeScienceRelay({ token, locked: process.argv.includes("--locked") });
  process.stdout.write(`OMB_CLOUD_SCIENCE_URL=${relay.base} OMB_CLOUD_SCIENCE_TOKEN=${token}\n`);
}
