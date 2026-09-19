// The text-to-speech HTTP routes, extracted verbatim from index.ts's
// dispatch chain. Path matching, methods, and status codes are unchanged;
// the handler returns false for anything it does not own so the chain falls
// through in the same order. Utterance splitting stays server-side, next to
// the transform that produced the transcript; the TTS key settings routes
// stay in index.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { cfg } from "../runtime.ts";
import * as tts from "../tts/index.ts";
import { toUtterances } from "../tts/speech-text.ts";

export function createTtsRoutes() {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path } = rctx;
    // ── voice ─────────────────────────────────────────────────────────
    // Splitting text into utterances lives HERE, not in the renderer, for
    // the same reason approvalKey does — it is the piece most likely to be
    // tuned against real transcripts, and it belongs next to the transform
    // that produced it.
    if (method === "POST" && path === "/api/tts/prepare") {
      const body = await readBody(req);
      json(res, 200, {
        ready: tts.voiceReady(cfg, typeof body.voiceId === "string" ? body.voiceId : undefined),
        utterances: toUtterances(String(body.text ?? "")),
      });
      return true;
    }
    if (method === "GET" && path === "/api/tts/voices") {
      try {
        json(res, 200, { voices: await tts.listVoices(cfg) });
        return true;
      } catch (e) {
        json(res, 200, { voices: [], error: e instanceof Error ? e.message : String(e) });
        return true;
      }
    }
    if (method === "POST" && path === "/api/tts/speak") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) {
        json(res, 400, { error: "text required" });
        return true;
      }
      // The normal client sends <=320-character utterances. A hard ceiling
      // prevents an arbitrary local request from turning the user's hosted
      // voice account into an unbounded, billable synthesis job.
      if (text.length > 500) {
        json(res, 413, { error: "voice utterances are limited to 500 characters" });
        return true;
      }
      try {
        const audio = await tts.speak(cfg, text, typeof body.voiceId === "string" ? body.voiceId : undefined);
        res.writeHead(200, {
          "content-type": audio.mime,
          "content-length": String(audio.bytes.byteLength),
          "cache-control": "no-store",
        });
        res.end(Buffer.from(audio.bytes));
        return true;
      } catch (e) {
        // "you haven't set this up yet" is not a provider failure — 409 so
        // the client can point at App Settings instead of showing a 502
        if (e instanceof tts.NoVoiceConfigured) {
          json(res, 409, { error: e.message });
          return true;
        }
        json(res, 502, { error: e instanceof Error ? e.message : String(e) });
        return true;
      }
    }
    return false;
  };
}
