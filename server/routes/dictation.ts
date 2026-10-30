import type { IncomingMessage } from "node:http";
import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS } from "../../shared/dictation.ts";
import { PASS, type RouteHandler } from "./table.ts";

const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/mpeg"]);
const ERROR_STATUS: Record<string, number> = { too_large: 413, too_long: 413, invalid_audio: 422, no_speech: 422, busy: 429, upload_timeout: 408 };

/** The transcription worker is private to this host; clients cannot choose an upstream address. */
export function dictationServiceUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const url = new URL(env.OMB_DICTATION_URL ?? "");
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function readAudio(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [], size = 0, done = false;
    const fail = (status: number, code: string) => {
      if (done) return;
      done = true;
      chunks = [];
      clearTimeout(timer);
      reject(Object.assign(new Error(code), { status, code }));
    };
    const timer = setTimeout(() => fail(408, "upload_timeout"), 20_000);
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > DICTATION_MAX_BYTES) return fail(413, "too_large");
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (done) return;
      if (!size) return fail(400, "invalid_audio");
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.once("aborted", () => fail(400, "cancelled"));
    req.once("error", () => fail(400, "invalid_audio"));
  });
}

export function createDictationRoutes(options: { url?: () => string | null; fetch?: typeof fetch } = {}): RouteHandler {
  const workerUrl = options.url ?? dictationServiceUrl;
  const request = options.fetch ?? fetch;
  let active = false;
  return async ({ req, res, path, method, json }) => {
    if (path !== "/api/dictation/status" && path !== "/api/dictation/transcribe") return PASS;
    res.setHeader("cache-control", "no-store");
    const upstream = workerUrl();
    if (method === "GET" && path === "/api/dictation/status") {
      let available = false;
      if (upstream) {
        try {
          const response = await request(`${upstream}/health`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
          const health = await response.json() as { ready?: unknown };
          available = response.ok && health.ready === true;
        } catch { /* The optional worker may be starting or stopped. */ }
      }
      return json(res, 200, { available, maxSeconds: DICTATION_MAX_SECONDS });
    }
    if (method !== "POST" || path !== "/api/dictation/transcribe") return PASS;
    const fail = (status: number, code: string) => json(res, status, { error: { code, message: code } });
    if (!upstream) return fail(503, "unavailable");
    if (!AUDIO_TYPES.has(String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase())) return fail(415, "invalid_audio");
    if (Number(req.headers["content-length"] ?? 0) > DICTATION_MAX_BYTES) { req.resume(); return fail(413, "too_large"); }
    if (active) { req.resume(); return fail(429, "busy"); }
    active = true;
    const cancel = new AbortController();
    const disconnected = () => { if (!res.writableEnded) cancel.abort(); };
    res.once("close", disconnected);
    try {
      const audio = await readAudio(req);
      const language = String(req.headers["x-dictation-language"] ?? "").toLowerCase();
      const response = await request(`${upstream}/transcribe`, {
        method: "POST", redirect: "error",
        headers: { "content-type": String(req.headers["content-type"]), ...(/^[a-z]{2,3}$/.test(language) ? { "x-dictation-language": language } : {}) },
        body: new Uint8Array(audio),
        signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(120_000)]),
      });
      const body = await response.json() as { text?: unknown; error?: { code?: unknown } };
      if (cancel.signal.aborted) return;
      if (!response.ok) {
        const code = typeof body?.error?.code === "string" ? body.error.code : "unavailable";
        return fail(ERROR_STATUS[code] ?? 503, ERROR_STATUS[code] ? code : "unavailable");
      }
      if (typeof body.text !== "string" || !body.text.trim()) return fail(422, "no_speech");
      if (body.text.length > 30_000) return fail(422, "invalid_audio");
      return json(res, 200, { text: body.text.trim() });
    } catch (error) {
      if (cancel.signal.aborted || res.destroyed) return;
      if (error instanceof Error && "status" in error && "code" in error) return fail(Number(error.status), String(error.code));
      return fail(error instanceof Error && error.name === "TimeoutError" ? 504 : 503, error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unavailable");
    } finally {
      active = false;
      res.off("close", disconnected);
    }
  };
}
