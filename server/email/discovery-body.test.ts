import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { makeTestTls } from "../testing/test-tls.ts";
import { liveDiscoverDeps, parseAutoconfig } from "./discover.ts";

const MAX_CHARS = 256 * 1024;
const root = mkdtempSync(join(tmpdir(), "omb-discovery-body-"));
const tls = makeTestTls(root);

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the response was not released")), 2_000); });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timer!); }
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!tls)("email discovery response bodies over actual HTTPS", () => {
  const servers: Server[] = [];
  const previous = getGlobalDispatcher();
  let agent: Agent;

  beforeAll(() => {
    agent = new Agent({ connect: { ca: tls!.cert } });
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  afterAll(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  async function serve(handler: RequestListener): Promise<string> {
    const server = createServer(tls!, handler);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `https://127.0.0.1:${(server.address() as { port: number }).port}/config.xml`;
  }

  it.each(["x", "🙂"])("cancels an oversized %s response before the server ends it", async character => {
    let onClose!: () => void;
    const closed = new Promise<void>(resolve => { onClose = resolve; });
    const url = await serve((_request, response) => {
      response.once("close", onClose);
      response.writeHead(200, { "content-type": "application/xml" });
      response.write(character.repeat(MAX_CHARS / character.length + 1));
    });
    expect(await promptly(liveDiscoverDeps(async () => true).fetchText(url))).toBeNull();
    await promptly(closed);
  });

  it("cancels a refused HTTP response without waiting for its body", async () => {
    let onClose!: () => void;
    const closed = new Promise<void>(resolve => { onClose = resolve; });
    const url = await serve((_request, response) => {
      response.once("close", onClose);
      response.writeHead(503, { "content-type": "application/xml" });
      response.write("not a configuration");
    });
    expect(await promptly(liveDiscoverDeps(async () => true).fetchText(url))).toBeNull();
    await promptly(closed);
  });

  it.each(["x", "中", "🙂"])("keeps exactly the existing character limit for %s", async character => {
    const content = character.repeat(MAX_CHARS / character.length);
    const url = await serve((_request, response) => response.end(content));
    expect(await liveDiscoverDeps(async () => true).fetchText(url)).toBe(content);
  });

  it("counts a replacement character emitted by the final UTF-8 decoder flush", async () => {
    const body = Buffer.concat([Buffer.alloc(MAX_CHARS, 0x61), Buffer.from([0xf0, 0x9f])]);
    const url = await serve((_request, response) => response.end(body));
    expect(await liveDiscoverDeps(async () => true).fetchText(url)).toBeNull();
  });

  it("keeps UTF-8 decoding and BOM removal for an ordinary autoconfig document", async () => {
    const xml = '<clientConfig><displayName>中文🙂</displayName><incomingServer type="imap"><hostname>imap.example.test</hostname><port>993</port><socketType>SSL</socketType></incomingServer></clientConfig>';
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]);
    const url = await serve((_request, response) => response.end(body));
    const text = await liveDiscoverDeps(async () => true).fetchText(url);
    expect(text).toBe(xml);
    expect(parseAutoconfig(text!, "example.test").imap).toEqual([{ host: "imap.example.test", port: 993, secure: true }]);
  });

  it("keeps the empty text of a response without a body", async () => {
    const url = await serve((_request, response) => { response.writeHead(204); response.end(); });
    expect(await liveDiscoverDeps(async () => true).fetchText(url)).toBe("");
  });

  it("does not connect when the existing address guard refuses", async () => {
    let requests = 0;
    const url = await serve((_request, response) => { requests += 1; response.end("configuration"); });
    expect(await liveDiscoverDeps(async () => false).fetchText(url)).toBeNull();
    expect(requests).toBe(0);
  });
});
