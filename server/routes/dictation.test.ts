import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { DICTATION_MAX_BYTES } from "../../shared/dictation.ts";
import { createDictationRoutes, dictationServiceUrl } from "./dictation.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function serve(request: typeof fetch, configured = true) {
  const routes = [createDictationRoutes({ url: () => configured ? "http://127.0.0.1:18810" : null, fetch: request })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: string | Uint8Array = "fixture audio", type = "audio/webm;codecs=opus") => fetch(`${base}/api/dictation/transcribe`, { method: "POST", headers: { "content-type": type, "x-dictation-language": "pt" }, body });
  return { base, post };
}

describe("private server dictation", () => {
  it("accepts only a configured loopback service and explicitly grants client scopes", () => {
    for (const url of ["https://example.com", "http://localhost:8810", "http://127.0.0.1:8810/path", "http://user:pass@127.0.0.1:8810", "http://127.0.0.1:8810/?x=1"]) expect(dictationServiceUrl({ OMB_DICTATION_URL: url })).toBeNull();
    expect(dictationServiceUrl({ OMB_DICTATION_URL: "http://127.0.0.1:8810" })).toBe("http://127.0.0.1:8810");
    expect(requiredScope("GET", "/api/dictation/status")).toBe("client");
    expect(requiredScope("POST", "/api/dictation/transcribe")).toBe("client");
    expect(requiredScope("POST", "/api/dictation/anything-else")).toBe("admin");
  });

  it("reports an unavailable optional worker without accepting audio", async () => {
    const worker = vi.fn<typeof fetch>();
    const { base, post } = await serve(worker, false);
    expect(await (await fetch(`${base}/api/dictation/status`)).json()).toEqual({ available: false, maxSeconds: 120 });
    expect((await post()).status).toBe(503);
    expect(worker).not.toHaveBeenCalled();
  });

  it("forwards bounded raw audio and returns only review text", async () => {
    const worker = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: "  Texto para revisar.  ", secret: "not forwarded" }));
    const { post } = await serve(worker);
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ text: "Texto para revisar." });
    const [url, init] = worker.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:18810/transcribe");
    expect(new TextDecoder().decode(init!.body as Uint8Array)).toBe("fixture audio");
    expect(new Headers(init!.headers).get("x-dictation-language")).toBe("pt");
    expect(init!.redirect).toBe("error");
  });

  it("reports readiness without exposing the worker URL or following redirects", async () => {
    const worker = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ready: true })).mockRejectedValueOnce(new TypeError("redirect refused"));
    const { base } = await serve(worker);
    expect(await (await fetch(`${base}/api/dictation/status`)).json()).toEqual({ available: true, maxSeconds: 120 });
    expect(worker.mock.calls[0]![1]!.redirect).toBe("error");
    expect(await (await fetch(`${base}/api/dictation/status`)).json()).toEqual({ available: false, maxSeconds: 120 });
  });

  it("refuses bad media, empty bodies and oversized uploads before inference", async () => {
    const worker = vi.fn<typeof fetch>();
    const { post } = await serve(worker);
    expect((await post("{}", "application/json")).status).toBe(415);
    expect((await post("")).status).toBe(400);
    expect((await post(new Uint8Array(DICTATION_MAX_BYTES + 1))).status).toBe(413);
    expect(worker).not.toHaveBeenCalled();
  });

  it("allows one transcription at a time and recovers after a failure", async () => {
    let finish!: (response: Response) => void;
    const worker = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(Response.json({ text: "Next recording" }));
    const { post } = await serve(worker);
    const first = post();
    await expect.poll(() => worker.mock.calls.length).toBe(1);
    expect((await post()).status).toBe(429);
    finish(Response.json({ error: { code: "no_speech" } }, { status: 422 }));
    expect((await first).status).toBe(422);
    expect((await post()).status).toBe(200);
  });

  it("bounds uploads without Content-Length and releases the inference slot", async () => {
    const worker = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: "Next" }));
    const { base, post } = await serve(worker);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/api/dictation/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" } }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      });
      request.once("error", reject);
      request.write(new Uint8Array(DICTATION_MAX_BYTES));
      request.end(new Uint8Array(1));
    });
    expect(status).toBe(413);
    expect(worker).not.toHaveBeenCalled();
    expect((await post()).status).toBe(200);
  });

  it("aborts a disconnected client's upstream request and accepts a later recording", async () => {
    let signal!: AbortSignal;
    const worker = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => {
      signal = init!.signal!;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }).mockResolvedValue(Response.json({ text: "Next" }));
    const { base, post } = await serve(worker);
    const controller = new AbortController();
    const first = fetch(`${base}/api/dictation/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: "synthetic", signal: controller.signal }).catch(() => null);
    await expect.poll(() => worker.mock.calls.length).toBe(1);
    controller.abort();
    await first;
    await expect.poll(() => signal.aborted).toBe(true);
    expect((await post()).status).toBe(200);
  });

  it("preserves worker upload timeouts, redacts details and releases the transcription slot", async () => {
    const worker = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "upload_timeout", message: "/private/audio/path" } }, { status: 408 }))
      .mockResolvedValue(Response.json({ text: "Next recording" }));
    const { post } = await serve(worker);
    const response = await post();
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: { code: "upload_timeout", message: "upload_timeout" } });
    expect((await post()).status).toBe(200);
  });

  it("does not return worker errors or paths to the client", async () => {
    const worker = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "traceback", message: "/private/audio/path" } }, { status: 500 }));
    const { post } = await serve(worker);
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("/private/audio/path");
  });
});
