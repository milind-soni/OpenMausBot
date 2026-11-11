// The voice routes: whether a voice is ready, the provider's voices (searched, or one pasted by ID or link), adding an
// ElevenLabs Voice Library voice to My Voices, speaking a line, and hearing speech. Scopes are keyed by path in server/request-auth.ts.
import type { AppConfig } from "../config.ts";
import { redactSecretsInText } from "../redact.ts";
import { voiceFailure } from "../tts/errors.ts";
import { listSpeechModels, transcribe } from "../stt.ts";
import { sttConfigSchema, sttNeedsKey, sttSavePatch, sttStatus, usableSttKey } from "../stt-config.ts";
import * as tts from "../tts/index.ts";
import { toUtterances, VOICE_FIRST_BLOCK_MAX_CHARS } from "../tts/speech-text.ts";
import { userError, userErrorFields } from "../user-errors.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** About six minutes of 16 kHz mono 16-bit PCM. */
export const TRANSCRIBE_MAX_BYTES = 12 * 1024 * 1024;

export interface TtsRouteDeps {
  config(): AppConfig;
}

export function createTtsRoutes(deps: TtsRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (!path.startsWith("/api/tts/")) return PASS;
    const cfg = deps.config();
    if (method === "POST" && path === "/api/tts/models") {
      const body = await readBody(req);
      const parsed = sttConfigSchema.safeParse(body.stt);
      if (!parsed.success) return json(res, 400, { error: "Invalid speech input settings." });
      const stt = { ...cfg.stt, ...sttSavePatch(cfg.stt, parsed.data) };
      if (stt.provider !== "openai" && stt.provider !== "gemini") return json(res, 400, { error: "Choose a speech input server first." });
      if (sttNeedsKey(stt) && !usableSttKey(stt)) return json(res, 409, { error: "Enter the speech input API key to load models." });
      try {
        return json(res, 200, { models: await listSpeechModels({ ...cfg, stt }) });
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : "Could not load speech input models." });
      }
    }
    if (method === "POST" && path === "/api/tts/prepare") {
      const body = await readBody(req);
      // Replies speak while they are still being written, from text no stored message has scrubbed yet: held secrets
      // are known only here, so they are masked here. The first block is short so the first sound comes soon.
      const text = redactSecretsInText(String(body.text ?? ""));
      return json(res, 200, {
        ready: tts.voiceReady(cfg, typeof body.voiceId === "string" ? body.voiceId : undefined),
        utterances: toUtterances(text, { firstBlockMaxChars: VOICE_FIRST_BLOCK_MAX_CHARS }),
      });
    }
    if (method === "GET" && path === "/api/tts/voices") {
      try {
        const search = {
          query: url.searchParams.get("q")?.slice(0, 200),
          current: url.searchParams.get("current") ?? undefined,
        };
        return json(res, 200, { voices: await tts.listVoices(cfg, undefined, search) });
      } catch (e) {
        return json(res, 200, { voices: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "POST" && path === "/api/tts/voices/add") {
      const body = await readBody(req);
      const id = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9]{1,128}$/.test(value) ? value : "");
      const publicOwnerId = id(body.publicOwnerId);
      const voiceId = id(body.voiceId);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
      if (!publicOwnerId || !voiceId || !name) return json(res, 400, { error: "publicOwnerId, voiceId and name required" });
      try {
        return json(res, 200, { voiceId: await tts.addSharedVoice(cfg, publicOwnerId, voiceId, name) });
      } catch (e) {
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "POST" && path === "/api/tts/speak") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      // A hard ceiling, so an arbitrary local request cannot turn the hosted voice account into an unbounded billable job.
      if (text.length > 500) return json(res, 413, userError("serverError.voice.utteranceTooLong"));
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", cancel);
      try {
        const audio = await tts.speak(cfg, text, typeof body.voiceId === "string" ? body.voiceId : undefined, undefined, controller.signal);
        if (controller.signal.aborted) return;
        res.writeHead(200, {
          "content-type": audio.mime,
          "content-length": String(audio.bytes.byteLength),
          "cache-control": "no-store",
        });
        res.end(Buffer.from(audio.bytes));
        return;
      } catch (e) {
        if (controller.signal.aborted) return;
        const failure = voiceFailure(e);
        if (failure) return json(res, failure.status, failure.body);
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      } finally {
        res.off("close", cancel);
      }
    }
    if (method === "POST" && path === "/api/tts/transcribe") {
      const rawType = req.headers["content-type"];
      const mime = (Array.isArray(rawType) ? rawType[0] : rawType)?.split(";")[0]?.trim().toLowerCase();
      if (mime !== "audio/wav") {
        req.resume();
        return json(res, 400, { error: "content-type must be audio/wav" });
      }
      if (!sttStatus(cfg).configured) {
        req.resume();
        return json(res, 409, userError("serverError.voice.speechInputRequired"));
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > TRANSCRIBE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `audio exceeds ${TRANSCRIBE_MAX_BYTES} bytes` });
      }
      const audio = await new Promise<Buffer | null>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        // Answering before the upload is read to its end resets the connection on Windows instead of delivering the 413.
        req.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received <= TRANSCRIBE_MAX_BYTES) chunks.push(chunk);
        });
        req.on("end", () => resolve(received > TRANSCRIBE_MAX_BYTES ? null : Buffer.concat(chunks)));
        req.on("error", reject);
      });
      if (!audio) return json(res, 413, { error: `audio exceeds ${TRANSCRIBE_MAX_BYTES} bytes` });
      try {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        res.on?.("close", cancel);
        try {
          return json(res, 200, { text: await transcribe(cfg, audio, mime, abort.signal) });
        } finally {
          res.off?.("close", cancel);
        }
      } catch (e) {
        return json(res, 502, { error: e instanceof Error ? e.message : String(e), ...userErrorFields(e) });
      }
    }
    return PASS;
  };
}
