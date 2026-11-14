import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { fetchPastLimit } from "./openai-chat-fetch.ts";

const servers: Server[] = [];

/** Creates a gate that tests can release when a network event occurs, without sleeps. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Starts a loopback HTTP fixture on an available port and registers it for cleanup.
 * @param handle Receives fixture requests and controls their responses.
 * @returns The fixture origin, including its assigned port.
 */
async function serve(handle: RequestListener): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }));
});

it("waits for response headers and delivers model output before the stream ends", async () => {
  const received = deferred();
  const headers = deferred();
  const finish = deferred();
  let body = "";
  const url = await serve(async (req, res) => {
    for await (const chunk of req) body += String(chunk);
    received.resolve();
    await headers.promise;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    await finish.promise;
    res.end("data: [DONE]\n\n");
  });
  const pending = fetchPastLimit(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture", stream: true }),
  });
  await received.promise;
  expect(JSON.parse(body)).toEqual({ model: "fixture", stream: true });
  headers.resolve();
  const response = await pending;
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"content":"hello"');
  expect(first.done).toBe(false);
  finish.resolve();
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += new TextDecoder().decode(chunk.value);
  }
  expect(rest).toContain("[DONE]");
});

it("cancels a slow model before it sends response headers", async () => {
  const received = deferred();
  const url = await serve(() => received.resolve());
  const controller = new AbortController();
  const pending = fetchPastLimit(url, { signal: controller.signal });
  await received.promise;
  controller.abort(new Error("fixture cancelled before headers"));
  await expect(pending).rejects.toThrow("fixture cancelled before headers");
});

it("cancels a model stream after the first output arrives", async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first output\n\n");
  });
  const controller = new AbortController();
  const response = await fetchPastLimit(url, { signal: controller.signal });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("first output");
  const pending = reader.read();
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
});

it("does not forward credentials or cookies to a different origin", async () => {
  let forwardedAuthorization: string | undefined;
  let forwardedCookie: string | undefined;
  let forwardedProxyAuthorization: string | undefined;
  let originalAuthorization: string | undefined;
  let originalCookie: string | undefined;
  let originalProxyAuthorization: string | undefined;
  const target = await serve((req, res) => {
    forwardedAuthorization = req.headers.authorization;
    forwardedCookie = req.headers.cookie;
    forwardedProxyAuthorization = req.headers["proxy-authorization"];
    res.end("redirected");
  });
  const source = await serve((req, res) => {
    originalAuthorization = req.headers.authorization;
    originalCookie = req.headers.cookie;
    originalProxyAuthorization = req.headers["proxy-authorization"];
    res.writeHead(302, { location: target });
    res.end();
  });
  const response = await fetchPastLimit(source, {
    headers: [
      ["authorization", "Bearer fixture-only-token"],
      ["cookie", "fixture=session"],
      ["proxy-authorization", "Basic fixture-only-proxy-token"],
    ],
  });
  expect(await response.text()).toBe("redirected");
  expect(originalAuthorization).toBe("Bearer fixture-only-token");
  expect(originalCookie).toBe("fixture=session");
  expect(originalProxyAuthorization).toBe("Basic fixture-only-proxy-token");
  expect(forwardedAuthorization).toBeUndefined();
  expect(forwardedCookie).toBeUndefined();
  expect(forwardedProxyAuthorization).toBeUndefined();
});

it("preserves credentials and cookies when redirecting within the same origin", async () => {
  const requests: { path: string | undefined; authorization: string | undefined; cookie: string | undefined; proxyAuthorization: string | undefined }[] = [];
  const origin = await serve((req, res) => {
    requests.push({
      path: req.url,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      proxyAuthorization: req.headers["proxy-authorization"],
    });
    if (req.url === "/source") {
      res.writeHead(302, { location: "/target" });
      res.end();
    } else {
      res.end("redirected within origin");
    }
  });
  const response = await fetchPastLimit(`${origin}/source`, {
    headers: [
      ["authorization", "Bearer fixture-only-token"],
      ["cookie", "fixture=session"],
      ["proxy-authorization", "Basic fixture-only-proxy-token"],
    ],
  });
  expect(await response.text()).toBe("redirected within origin");
  expect(requests).toEqual(["/source", "/target"].map((path) => ({
    path,
    authorization: "Bearer fixture-only-token",
    cookie: "fixture=session",
    proxyAuthorization: "Basic fixture-only-proxy-token",
  })));
});

it("preserves provider HTTP errors for the model runtime to handle", async () => {
  const url = await serve((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fixture provider unavailable" } }));
  });
  const response = await fetchPastLimit(url, {});
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { message: "fixture provider unavailable" } });
});
