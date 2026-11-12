// The telephony door on the public webhook receiver: Twilio's voice and SMS webhooks
// come in here, signed with the account's auth token. A call from the owner is bridged
// into LiveKit (where the voice worker answers with Deepgram STT and the cloned OpenVoice
// TTS) or, with no SIP address, stays on Twilio's own speech recognition; either way the
// words and the facts land in the same cross-channel store the app reads.
import type { IncomingMessage, ServerResponse } from "node:http";

import { chatCompletion, openRouterKey, type ChatMessage, type OpenRouterTier } from "../llm/openrouter.ts";
import { speakable } from "../tts/speech-text.ts";
import { header, json, readRawBody, type IngressDoor } from "../webhook-ingress.ts";
import { configured, isOwner, sendSms, type TelephonyConfig } from "./service.ts";
import { parseForm, TWILIO_SIGNATURE_HEADER, verifyTwilioSignature } from "./signature.ts";
import type { CallStatus, TelephonyStore } from "./store.ts";

export const MAX_CALL_TURNS = 20;
const TWIML_TYPE = "text/xml";

export type TelephonyChat = (tier: Extract<OpenRouterTier, "live" | "background">, messages: readonly ChatMessage[], signal?: AbortSignal) => Promise<string>;

export interface TelephonyDoorDeps {
  config(): TelephonyConfig;
  store: TelephonyStore;
  now?: () => number;
  /** The door's LLM: OpenRouter tiers by default, overridable for tests and proxies. */
  chat?: TelephonyChat;
  fetch?: typeof fetch;
  /** "allow" lets the door answer the owner's texts by itself; "ask" drafts one for approval. Default "ask". */
  smsAutoreply?: () => "ask" | "allow";
}

const xml = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": TWIML_TYPE });
  res.end(body);
};

const response = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;
const say = (words: string) => `<Say>${escapeXml(speakable(words))}</Say>`;
const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The LLM's standing voice: plain words, short turns, out loud. */
function voiceMessages(store: TelephonyStore, userText: string): ChatMessage[] {
  const context = store.recentContext(20);
  return [
    {
      role: "system",
      content:
        "You are OpenMausBot, the owner's assistant, talking on a phone call. Reply in plain spoken words: no markdown, bullets, links or emoji, under 60 words. Use the call and message history when it helps." +
        (context.length ? `\nRecent calls, messages and remembered facts:\n${context.join("\n")}` : ""),
    },
    { role: "user", content: userText },
  ];
}

export function createTelephonyDoor(deps: TelephonyDoorDeps): IngressDoor {
  const now = deps.now ?? Date.now;
  const chat: TelephonyChat =
    deps.chat ??
    (async (tier, messages) => {
      const key = openRouterKey();
      if (!key) throw new Error("OpenRouter is not configured. Set OPENROUTER_API_KEY or OMB_OPENROUTER_API_KEY in .env.");
      return (await chatCompletion(tier, { messages }, { key })).text;
    });
  const fetcher = deps.fetch ?? fetch;
  const smsAutoreply = deps.smsAutoreply ?? (() => ((process.env.TELEPHONY_SMS_AUTOREPLY?.trim() || "ask") === "allow" ? "allow" : "ask"));

  /** The voice worker's private line in: one bearer token, then events land in the shared store. */
  const ingest = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const expected = process.env.TELEPHONY_INGEST_TOKEN?.trim() ?? "";
    if (!expected) {
      json(res, 503, { error: "The voice worker's ingest is off. Set TELEPHONY_INGEST_TOKEN in .env." });
      return true;
    }
    if ((header(req, "authorization") ?? "") !== `Bearer ${expected}`) {
      json(res, 401, { error: "Invalid ingest token" });
      return true;
    }
    let body: {
      kind?: string;
      id?: string;
      callId?: string;
      from?: string;
      to?: string;
      who?: string;
      text?: string;
      status?: CallStatus;
      durationSec?: number;
      objective?: string;
    };
    try {
      body = JSON.parse(await readRawBody(req)) as typeof body;
    } catch {
      json(res, 400, { error: "The ingest body is not readable" });
      return true;
    }
    switch (body.kind) {
      case "call":
        if (!body.id || !body.from) {
          json(res, 400, { error: "A call event needs id and from" });
          return true;
        }
        deps.store.appendCall({
          id: body.id,
          direction: "in",
          from: body.from,
          to: body.to ?? deps.config().botPhoneNumber,
          at: now(),
          status: "answered",
          ...(body.objective ? { objective: body.objective } : {}),
        });
        break;
      case "turn": {
        if (!body.callId || !body.text || (body.who !== "caller" && body.who !== "bot")) {
          json(res, 400, { error: "A turn event needs callId, who (caller or bot) and text" });
          return true;
        }
        deps.store.appendCallTurn(body.callId, { who: body.who, text: body.text, at: now() });
        break;
      }
      case "fact":
        if (!body.text?.trim()) {
          json(res, 400, { error: "A fact event needs text" });
          return true;
        }
        deps.store.appendFact(body.text, "voice");
        break;
      case "call_end": {
        if (!body.callId) {
          json(res, 400, { error: "A call_end event needs callId" });
          return true;
        }
        deps.store.patchCall(body.callId, {
          status: body.status ?? "done",
          ...(typeof body.durationSec === "number" && body.durationSec > 0 ? { durationSec: body.durationSec } : {}),
        });
        break;
      }
      default:
        json(res, 400, { error: "Unknown ingest event kind" });
        return true;
    }
    json(res, 200, { ok: true });
    return true;
  };

  /** Only a signed request from the account is a Twilio webhook. */
  const signed = (req: IncomingMessage, url: URL, params: Record<string, string>): boolean => {
    const config = deps.config();
    if (!config.publicUrl) return false;
    if (!configured(config)) return false;
    const signedUrl = `${config.publicUrl}${url.pathname}${url.search}`;
    return verifyTwilioSignature({
      url: signedUrl,
      params,
      header: header(req, TWILIO_SIGNATURE_HEADER),
      token: config.authToken,
    });
  };

  const recordCall = (record: { direction: "in" | "out"; from: string; to: string; status: CallStatus; objective?: string }, id: string) => {
    const config = deps.config();
    return deps.store.appendCall({
      id,
      direction: record.direction,
      from: record.from || config.botPhoneNumber,
      to: record.to || (record.direction === "in" ? config.botPhoneNumber : ""),
      at: now(),
      status: record.status,
      ...(record.objective ? { objective: record.objective } : {}),
    });
  };

  const gatherLoop = (prompt: string) =>
    `<Gather input="speech" action="${escapeXml(basePath(deps.config()))}/turn" method="POST" timeout="6" speechTimeout="auto" language="en-US">${say(prompt)}</Gather>`;

  const basePath = (config: TelephonyConfig) => `${config.publicUrl}/hooks/telephony/voice`;

  return async (req, res, url) => {
    if (!url.pathname.startsWith("/hooks/telephony/")) return false;
    if (req.method !== "POST") return false;

    // The voice worker records what it hears and says here, so the store has one writer.
    if (url.pathname === "/hooks/telephony/ingest") return ingest(req, res);
    const contentType = header(req, "content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      json(res, 415, { error: "Twilio webhooks are form-encoded" });
      return true;
    }
    let raw: string;
    try {
      raw = await readRawBody(req);
    } catch {
      json(res, 413, { error: "Webhook body is too large" });
      return true;
    }
    const params = parseForm(raw);
    if (!signed(req, url, params)) {
      if (!deps.config().publicUrl || !configured(deps.config())) json(res, 503, { error: "Telephony is not configured" });
      else json(res, 401, { error: "Invalid Twilio signature" });
      return true;
    }
    const config = deps.config();
    const from = params.From ?? "";
    const callSid = params.CallSid ?? "";

    if (url.pathname === "/hooks/telephony/sms") {
      const body = (params.Body ?? "").trim();
      const record = deps.store.appendSms({ direction: "in", from, to: config.botPhoneNumber, body, at: now(), status: "received" });
      if (body) deps.store.appendFact(`SMS from ${from || "an unknown number"}: ${body}`, "sms");
      const autoreply = smsAutoreply() === "allow";
      if (autoreply && isOwner(from, config)) {
        try {
          const reply = speakable(await chat("background", voiceMessages(deps.store, `The owner texted: "${body}". Reply in one SMS.`))).slice(0, 320);
          const sent = await sendSms(config, { to: from, body: reply }, fetcher);
          if (sent.ok) {
            deps.store.appendSms({ direction: "out", from: config.botPhoneNumber, to: from, body: reply, at: now(), status: "sent", replyTo: record.id });
            deps.store.patchSms(record.id, { status: "sent", proposedReply: undefined });
          }
        } catch {
          // The SMS stays in the store, unsent, for the person to answer.
        }
      } else if (isOwner(from, config)) {
        try {
          const draft = await chat("background", voiceMessages(deps.store, `The owner texted: "${body}". Draft one SMS reply for approval.`));
          deps.store.patchSms(record.id, { proposedReply: speakable(draft).slice(0, 320) });
        } catch {
          // No OpenRouter key: the SMS waits in the store for the person to read it.
        }
      }
      xml(res, 200, response(""));
      return true;
    }

    if (url.pathname === "/hooks/telephony/voice") {
      if (!isOwner(from, config)) {
        recordCall({ direction: "in", from, to: config.botPhoneNumber, status: "voicemail" }, callId(callSid));
        const recording = `${escapeXml(basePath(config))}/recording`;
        xml(
          res,
          200,
          response(
            `${say("Hello, you have reached the owner's assistant. They cannot take your call. Please leave a message after the beep.")}` +
              `<Record action="${recording}" method="POST" maxLength="60" playBeep="true" />`,
          ),
        );
        return true;
      }
      recordCall({ direction: "in", from, to: config.botPhoneNumber, status: "answered" }, callId(callSid));
      if (config.livekitSipUri) {
        deps.store.appendFact(`Phone call from the owner bridged into LiveKit at ${new Date(now()).toISOString()}.`, "phone");
        xml(
          res,
          200,
          response(
            `${say("Connecting you to your assistant.")}<Dial record="record-from-answer-dual" recordingStatusCallback="${escapeXml(basePath(config))}/status"><Sip>${escapeXml(config.livekitSipUri)}</Sip></Dial>`,
          ),
        );
        return true;
      }
      xml(res, 200, response(gatherLoop("Hello. This is your assistant. How can I help?")));
      return true;
    }

    if (url.pathname === "/hooks/telephony/voice/outbound") {
      const objective = url.searchParams.get("objective")?.trim() || params.objective || "";
      recordCall({ direction: "out", from: config.botPhoneNumber, to: params.To ?? "", status: "answered", objective }, callId(callSid));
      xml(res, 200, response(gatherLoop(`Hello, this is the owner's assistant calling about: ${objective}. Are you there?`)));
      return true;
    }

    if (url.pathname === "/hooks/telephony/voice/turn") {
      const spoken = (params.SpeechResult ?? "").trim();
      if (!spoken) {
        xml(res, 200, response(`${say("I did not catch that.")}${gatherLoop("Say that again?")}`));
        return true;
      }
      const callIdStr = callId(callSid);
      const turns = deps.store.listCalls().find((call) => call.id === callIdStr)?.turns?.length ?? 0;
      deps.store.appendCallTurn(callIdStr, { who: "caller", text: spoken, at: now() });
      if (turns >= MAX_CALL_TURNS) {
        const goodbye = "We have been talking a while, so I will hang up here. Call back any time.";
        deps.store.appendCallTurn(callIdStr, { who: "bot", text: goodbye, at: now() });
        xml(res, 200, response(say(goodbye)));
        return true;
      }
      let reply: string;
      try {
        reply = speakable(await chat("live", voiceMessages(deps.store, spoken))).slice(0, 600);
      } catch {
        reply = "My connection to my brain is down. Try again in a moment.";
      }
      deps.store.appendCallTurn(callIdStr, { who: "bot", text: reply, at: now() });
      xml(res, 200, response(gatherLoop(reply || "Mmm.")));
      return true;
    }

    if (url.pathname === "/hooks/telephony/voice/recording") {
      const text = (params.TranscriptionText ?? params.SpeechResult ?? "").trim();
      const fromLabel = from || "an unknown caller";
      if (text) deps.store.appendFact(`Voicemail from ${fromLabel}: ${text}`, "phone");
      const callIdStr = callId(callSid);
      deps.store.patchCall(callIdStr, { status: "voicemail", recordingUrl: params.RecordingUrl ?? undefined });
      xml(res, 200, response(say("Thank you. Goodbye.")));
      return true;
    }

    if (url.pathname === "/hooks/telephony/status") {
      const status: CallStatus =
        params.DialCallStatus === "completed" || params.CallStatus === "completed"
          ? "done"
          : params.CallStatus === "no-answer" || params.CallStatus === "canceled"
            ? "missed"
            : params.CallStatus === "busy" || params.CallStatus === "failed"
              ? "failed"
              : "answered";
      const seconds = Number(params.DialCallDuration ?? params.CallDuration ?? 0);
      deps.store.patchCall(callId(callSid), {
        status,
        ...(Number.isFinite(seconds) && seconds > 0 ? { durationSec: seconds } : {}),
        ...(params.RecordingUrl ? { recordingUrl: params.RecordingUrl } : {}),
      });
      xml(res, 200, response(""));
      return true;
    }

    return false;
  };
}

const callId = (callSid: string) => (callSid ? `call_tw_${callSid}` : `call_local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);