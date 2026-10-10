// POST /api/stt/transcribe: one finished utterance in (16 kHz mono PCM WAV,
// raw request body), its text out. Used by the renderer's universal speech
// engine on Windows and Linux; macOS keeps Apple's on-device helper.
//
// Scope: not listed in server/request-auth.ts, so it is admin/loopback-only
// by default. A paired phone or remote page cannot stream audio into the
// host's billed STT account, matching the existing "calls are local" rule.
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../config.ts";
import * as stt from "../stt/index.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SttRouteDeps {
  config(): AppConfig;
  /** Test seam; production passes stt.transcribe. */
  transcribe?: typeof stt.transcribe;
}

/** A call is one speaker taking turns; interim partials add at most one
 * more request. Anything beyond this is a runaway client, not a user. */
const MAX_IN_FLIGHT = 3;

function readAudio(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > limit) {
        // keep draining so the 413 can still be delivered
        failed = true;
        chunks.length = 0;
        return reject(new stt.InvalidAudio("utterance is too long", 413));
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

export function createSttRoutes(deps: SttRouteDeps): RouteHandler {
  const transcribe = deps.transcribe ?? stt.transcribe;
  let inFlight = 0;

  return async ({ req, res, path, method, json }) => {
    if (path !== "/api/stt/transcribe") return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });

    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "audio/wav" && type !== "audio/x-wav" && type !== "audio/wave") {
      return json(res, 415, { error: "send audio/wav" });
    }
    const cfg = deps.config();
    // Answer "not set up" before accepting any audio.
    const problem = stt.sttSetupProblem(cfg);
    if (problem) return json(res, 409, { error: problem.message, reason: problem.reason });
    if (inFlight >= MAX_IN_FLIGHT) return json(res, 429, { error: "too many transcriptions in progress" });

    inFlight += 1;
    const abort = new AbortController();
    // The client dropped (the user hung up mid-request): stop paying for it.
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const utterance = stt.parseUtteranceWav(await readAudio(req, stt.MAX_WAV_BYTES));
      if (utterance.durationMs < stt.MIN_UTTERANCE_MS) return json(res, 200, { text: "" });
      const result = await transcribe(cfg, utterance, { signal: abort.signal });
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { text: result.text, ...(result.language ? { language: result.language } : {}) });
    } catch (error) {
      if (error instanceof stt.InvalidAudio) return json(res, error.status, { error: error.message });
      if (error instanceof stt.NoSttConfigured) return json(res, 409, { error: error.message, reason: error.reason });
      if (abort.signal.aborted) return;
      return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight -= 1;
    }
  };
}
