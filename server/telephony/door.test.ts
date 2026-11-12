import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { IngressDoor } from "../webhook-ingress.ts";
import type { TelephonyChat } from "./door.ts";
import { createTelephonyDoor } from "./door.ts";
import type { TelephonyConfig } from "./service.ts";
import { twilioSignature } from "./signature.ts";
import { openTelephonyStore, type TelephonyStore } from "./store.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const config: TelephonyConfig = {
  accountSid: "ACtest",
  authUser: "ACtest",
  authToken: "test-auth-token",
  botPhoneNumber: "+15186608998",
  ownerPhoneNumber: "+15187446390",
  publicUrl: "https://bots.example",
};

function store(): TelephonyStore {
  const dir = mkdtempSync(join(tmpdir(), "omb-door-"));
  dirs.push(dir);
  return openTelephonyStore(join(dir, "telephony", "store.json"));
}

/** A signed Twilio form request, exactly as the door receives it. */
function request(pathWithQuery: string, params: Record<string, string>, headers: Record<string, string> = {}, signWith: string = config.authToken) {
  const body = new URLSearchParams(params).toString();
  const url = new URL(`https://bots.example${pathWithQuery}`);
  const signature = twilioSignature(`${config.publicUrl}${url.pathname}${url.search}`, params, signWith);
  const req = {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
  return { req, url };
}

function response() {
  let code = 0;
  let text = "";
  const heads: Record<string, string> = {};
  const res = {
    writeHead(c: number, h?: Record<string, string>) {
      code = c;
      Object.assign(heads, h ?? {});
      return this;
    },
    end(data?: string) {
      if (data) text += data;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, status: () => code, body: () => text };
}

async function knock(door: IngressDoor, pathWithQuery: string, params: Record<string, string>, headers: Record<string, string> = {}, signWith?: string) {
  const { req, url } = request(pathWithQuery, params, headers, signWith);
  const out = response();
  const handled = await door(req, out.res, url);
  return { handled, ...out };
}

function makeDoor(deps: Partial<Parameters<typeof createTelephonyDoor>[0]> = {}) {
  return createTelephonyDoor({
    config: () => config,
    store: deps.store ?? store(),
    chat: deps.chat ?? (async () => "Sure thing."),
    fetch: deps.fetch,
    smsAutoreply: deps.smsAutoreply,
  });
}

describe("the telephony door", () => {
  it("accepts a webhook signed with the account auth token while an API key drives REST", async () => {
    // Inbound calls arrive signed with the account auth token; the API key
    // secret only authenticates REST calls and their callbacks.
    const accountToken = "account-auth-token";
    const door = createTelephonyDoor({
      config: () => ({ ...config, signTokens: [accountToken, "api-key-secret"] }),
      store: store(),
      chat: async () => "hi",
    });
    const result = await knock(door, "/hooks/telephony/voice", { From: "+15187446390", CallSid: "CA-token" }, {}, accountToken);
    expect(result.handled).toBe(true);
    expect(result.status()).toBe(200);
    expect(result.body()).toContain("<Gather");
  });

  it("answers only signed Twilio webhooks", async () => {
    const door = makeDoor();
    const badSignature = await knock(door, "/hooks/telephony/sms", { From: "+15187446390", Body: "hi" }, { "x-twilio-signature": "nope" });
    expect(badSignature.handled).toBe(true);
    expect(badSignature.status()).toBe(401);

    const wrongType = await knock(door, "/hooks/telephony/sms", { From: "+15187446390", Body: "hi" }, { "content-type": "application/json" });
    expect(wrongType.status()).toBe(415);

    const unconfigured = createTelephonyDoor({
      config: () => ({ ...config, publicUrl: undefined }),
      store: store(),
      chat: async () => "hi",
    });
    const result = await knock(unconfigured, "/hooks/telephony/sms", { From: "+15187446390", Body: "hi" });
    expect(result.status()).toBe(503);
  });

  it("bridges the owner into LiveKit when a SIP address is configured", async () => {
    const sip = createTelephonyDoor({
      config: () => ({ ...config, livekitSipUri: "sip:worker@sip.livekit.io" }),
      store: store(),
      chat: async () => "hi",
    });
    const result = await knock(sip, "/hooks/telephony/voice", { From: "+15187446390", CallSid: "CA1" });
    expect(result.status()).toBe(200);
    expect(result.body()).toContain("<Sip>sip:worker@sip.livekit.io</Sip>");
    expect(result.body()).toContain("<Dial");
  });

  it("keeps the owner on a speech loop with no SIP address", async () => {
    const theStore = store();
    const door = makeDoor({ store: theStore });
    const result = await knock(door, "/hooks/telephony/voice", { From: "+15187446390", CallSid: "CA2" });
    expect(result.status()).toBe(200);
    expect(result.body()).toContain("<Gather");
    expect(theStore.listCalls()[0]!.status).toBe("answered");
  });

  it("sends strangers to voicemail and keeps the transcription as a fact", async () => {
    const theStore = store();
    const door = makeDoor({ store: theStore });
    const result = await knock(door, "/hooks/telephony/voice", { From: "+15551234567", CallSid: "CA3" });
    expect(result.status()).toBe(200);
    expect(result.body()).toContain("<Record");
    expect(theStore.listCalls()[0]!.status).toBe("voicemail");

    const note = await knock(door, "/hooks/telephony/voice/recording", {
      From: "+15551234567",
      CallSid: "CA3",
      TranscriptionText: "Just checking the schedule for Friday",
    });
    expect(note.status()).toBe(200);
    expect(theStore.facts()[0]!.text).toContain("checking the schedule");
  });

  it("answers a spoken turn with plain spoken words", async () => {
    const theStore = store();
    const calls: Array<{ tier: string; lastUser: string }> = [];
    const chat: TelephonyChat = async (tier, messages) => {
      calls.push({ tier, lastUser: messages[messages.length - 1]!.content });
      return "**Bold** and a [link](https://example.com) plus bullets:\n- one";
    };
    const door = makeDoor({ store: theStore, chat });
    await knock(door, "/hooks/telephony/voice", { From: "+15187446390", CallSid: "CA4" });
    const turn = await knock(door, "/hooks/telephony/voice/turn", { From: "+15187446390", CallSid: "CA4", SpeechResult: "what is on my calendar" });
    expect(turn.status()).toBe(200);
    expect(calls[0]!.tier).toBe("live");
    expect(calls[0]!.lastUser).toBe("what is on my calendar");
    expect(turn.body()).not.toContain("**");
    expect(turn.body()).not.toContain("https://example.com");
    expect(turn.body()).toContain("<Gather");
    const call = theStore.listCalls().find((c) => c.id === "call_tw_CA4");
    expect(call!.turns).toHaveLength(2);
  });

  it("hangs up when the caller says goodbye", async () => {
    const theStore = store();
    const asked: string[] = [];
    const door = makeDoor({
      store: theStore,
      chat: async (_tier, messages) => {
        asked.push(messages[messages.length - 1]!.content);
        return "I would have replied.";
      },
    });
    await knock(door, "/hooks/telephony/voice", { From: "+15187446390", CallSid: "CA-hangup" });
    const bye = await knock(door, "/hooks/telephony/voice/turn", { From: "+15187446390", CallSid: "CA-hangup", SpeechResult: "okay thanks, that's all, goodbye" });
    expect(bye.status()).toBe(200);
    expect(bye.body()).toContain("<Hangup");
    expect(bye.body()).not.toContain("<Gather");
    expect(asked).toHaveLength(0);
    const call = theStore.listCalls().find((c) => c.id === "call_tw_CA-hangup");
    expect(call!.status).toBe("done");
    expect(call!.turns!.at(-1)!.who).toBe("bot");
  });

  it("keeps the call going when the farewell is negated", async () => {
    const theStore = store();
    const door = makeDoor({ store: theStore });
    await knock(door, "/hooks/telephony/voice", { From: "+15187446390", CallSid: "CA-stay" });
    const stay = await knock(door, "/hooks/telephony/voice/turn", { From: "+15187446390", CallSid: "CA-stay", SpeechResult: "don't hang up yet, one more thing" });
    expect(stay.status()).toBe(200);
    expect(stay.body()).toContain("<Gather");
    expect(stay.body()).not.toContain("<Hangup");
  });

  it("repeats its last reply without calling the brain", async () => {
    const theStore = store();
    const asked: string[] = [];
    const door = makeDoor({
      store: theStore,
      chat: async () => {
        asked.push("asked");
        return "The groceries arrive at five.";
      },
    });
    await knock(door, "/hooks/telephony/voice", { From: "+15187446390", CallSid: "CA-repeat" });
    await knock(door, "/hooks/telephony/voice/turn", { From: "+15187446390", CallSid: "CA-repeat", SpeechResult: "when do the groceries arrive" });
    const again = await knock(door, "/hooks/telephony/voice/turn", { From: "+15187446390", CallSid: "CA-repeat", SpeechResult: "sorry, what did you say?" });
    expect(again.status()).toBe(200);
    expect(again.body()).toContain("The groceries arrive at five.");
    expect(again.body()).toContain("<Gather");
    expect(asked).toHaveLength(1);
  });

  it("says goodbye after the turn limit", async () => {
    const theStore = store();
    theStore.appendCall({ id: "call_tw_CA5", direction: "in", from: "+15187446390", to: "+15186608998", at: 1, status: "answered" });
    for (let i = 0; i < 20; i++) theStore.appendCallTurn("call_tw_CA5", { who: "caller", text: `turn ${i}`, at: i });
    const door = makeDoor({ store: theStore });
    const turn = await knock(door, "/hooks/telephony/voice/turn", { From: "+15187446390", CallSid: "CA5", SpeechResult: "still here" });
    expect(turn.body()).toContain("hang up");
    expect(turn.body()).toContain("<Hangup");
    expect(turn.body()).not.toContain("<Gather");
  });

  it("drafts a reply to the owner's SMS when autoreply is ask", async () => {
    const theStore = store();
    const door = makeDoor({ store: theStore, smsAutoreply: () => "ask" });
    const result = await knock(door, "/hooks/telephony/sms", { From: "+15187446390", Body: "lunch at one?" });
    expect(result.status()).toBe(200);
    const inbound = theStore.listSms()[0]!;
    expect(inbound.status).toBe("received");
    expect(inbound.proposedReply).toBe("Sure thing.");
    expect(theStore.facts()[0]!.text).toContain("lunch at one?");
  });

  it("sends the autoreply itself when autoreply is allow", async () => {
    const theStore = store();
    const posted: string[] = [];
    const twilioFetch = (async (_url: unknown, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 });
    }) as typeof fetch;
    const door = makeDoor({ store: theStore, fetch: twilioFetch, smsAutoreply: () => "allow" });
    const result = await knock(door, "/hooks/telephony/sms", { From: "+15187446390", Body: "lunch at one?" });
    expect(result.status()).toBe(200);
    expect(posted[0]).toContain("Body=Sure+thing.");
    const messages = theStore.listSms();
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.direction === "out")!.status).toBe("sent");
  });

  it("records a stranger's SMS without drafting a reply", async () => {
    const theStore = store();
    const door = makeDoor({ store: theStore, fetch: (async () => {
      throw new Error("must not send");
    }) as typeof fetch, smsAutoreply: () => "allow" });
    const result = await knock(door, "/hooks/telephony/sms", { From: "+15550000000", Body: "spam?" });
    expect(result.status()).toBe(200);
    expect(theStore.listSms()).toHaveLength(1);
  });

  it("ignores paths it does not own", async () => {
    const door = makeDoor();
    const { req, url } = request("/hooks/something-else", { Body: "x" });
    const out = response();
    expect(await door(req, out.res, url)).toBe(false);
  });

  it("records the voice worker's turns and facts through the ingest line", async () => {
    const theStore = store();
    const door = makeDoor({ store: theStore });
    const jsonRequest = (path: string, payload: unknown, authorization?: string) => {
      const body = JSON.stringify(payload);
      const req = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body);
        },
      } as unknown as IncomingMessage;
      return { req, url: new URL(`https://bots.example${path}`) };
    };
    const knockJson = async (payload: unknown, authorization?: string) => {
      const { req, url } = jsonRequest("/hooks/telephony/ingest", payload, authorization);
      const out = response();
      expect(await door(req, out.res, url)).toBe(true);
      return out;
    };

    delete process.env.TELEPHONY_INGEST_TOKEN;
    expect((await knockJson({ kind: "fact", text: "x" })).status()).toBe(503);
    process.env.TELEPHONY_INGEST_TOKEN = "ingest-secret";
    expect((await knockJson({ kind: "fact", text: "x" })).status()).toBe(401);

    expect((await knockJson({ kind: "call", id: "call_worker_1", from: "+15187446390" }, "Bearer ingest-secret")).status()).toBe(200);
    expect((await knockJson({ kind: "turn", callId: "call_worker_1", who: "caller", text: "hey there" }, "Bearer ingest-secret")).status()).toBe(200);
    expect((await knockJson({ kind: "turn", callId: "call_worker_1", who: "bot", text: "hello" }, "Bearer ingest-secret")).status()).toBe(200);
    expect((await knockJson({ kind: "fact", text: "the owner called from the car" }, "Bearer ingest-secret")).status()).toBe(200);
    expect((await knockJson({ kind: "call_end", callId: "call_worker_1", status: "done", durationSec: 42 }, "Bearer ingest-secret")).status()).toBe(200);

    const call = theStore.listCalls().find((c) => c.id === "call_worker_1");
    expect(call!.turns).toHaveLength(2);
    expect(call!.status).toBe("done");
    expect(call!.durationSec).toBe(42);
    expect(theStore.facts()[0]!.text).toBe("the owner called from the car");

    expect((await knockJson({ kind: "turn", callId: "x", who: "nope", text: "y" }, "Bearer ingest-secret")).status()).toBe(400);
    delete process.env.TELEPHONY_INGEST_TOKEN;
  });
});
