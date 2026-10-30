// The decision backends' order (own Jev, own Workers AI, Cloud's included relay, OpenRouter, off), Clef's wire format on
// Workers AI, and the relay's seams, checked against the fixtures the Admin shares. No live calls: every fetch is a fake.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import clefWire from "./fixtures/workers-ai-clef.json" with { type: "json" };
import relayFixtures from "./fixtures/relay-seams.json" with { type: "json" };
import { createDecider, deciderAccount, deciderReady, deciderSavePatch, describeDecider } from "./index.ts";
import { inboxTriageRequest } from "./inbox-triage.ts";
import { jevRequestBody, RELAY_SEAM_HEADER } from "./jev.ts";
import { relayAccepts } from "./relay.ts";
import type { DeciderQuestion, DeciderSeam } from "./types.ts";
import { clefRequestBody, workersAiEndpoint } from "./workers-ai.ts";

const JEV_KEY = "tsk_order_jev_key_0123456789";
const CF_TOKEN = "cf_order_workers_ai_token_0123456789";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OR_KEY = "sk-or-v1-order-key-0123456789";
const SHARED = "sk-or-v1-order-shared-0123456789";
const RELAY = "https://cloud.example.test/api/cloud/services/decider";
const INCLUDED = "omb_decide_order_included_token_0123456789";
const CF_RUN = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare`;

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Answers a yes/no in every backend's shape: Jev, Workers AI's envelope, and OpenRouter chat. */
const anyYes = () => vi.fn<typeof fetch>(async (url) => {
  const where = String(url);
  if (where.endsWith("/chat/completions")) return json({ choices: [{ message: { content: JSON.stringify({ answers: { answer: { noul: 0.9 } } }) } }] });
  if (where.includes("cloudflare.com")) return json({ result: { model: "clef-flash", answers: { answer: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 9, output_tokens: 0 } }, success: true, errors: [], messages: [] });
  return json({ answers: { answer: { type: "noul", noul: 0.9 } } });
});
const sent = (fetchImpl: FetchMock, index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index]!;
  const headers = init!.headers as Record<string, string>;
  return { url: String(url), auth: headers.authorization, seam: headers[RELAY_SEAM_HEADER], body: JSON.parse(String(init!.body)) };
};
const decider = (config: AppConfig, fetchImpl: FetchMock) => createDecider({ config: () => config, fetch: fetchImpl as unknown as typeof fetch });
const cloud = () => {
  vi.stubEnv("OMB_CLOUD_DECIDER_URL", RELAY);
  vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", INCLUDED);
};

afterEach(() => vi.unstubAllEnvs());

describe("the order: own Jev, own Workers AI, Cloud's included relay, OpenRouter, off", () => {
  const all: AppConfig = {
    openrouter: { key: SHARED },
    decider: { enabled: true, key: JEV_KEY, workersAiToken: CF_TOKEN, workersAiAccountId: ACCOUNT, openrouterKey: OR_KEY },
  };
  const without = (...fields: Array<"key" | "workersAiToken" | "openrouterKey">): AppConfig => ({
    ...all, decider: Object.fromEntries(Object.entries(all.decider!).filter(([field]) => !fields.includes(field as never))),
  });

  it.each([
    ["every key", without(), "jev", "https://api.typesafe.ai/v1/systemone", `Bearer ${JEV_KEY}`],
    ["no Jev key", without("key"), "workersai", `${CF_RUN}/clef-flash`, `Bearer ${CF_TOKEN}`],
    ["no Jev or Workers AI key", without("key", "workersAiToken"), "jev", `${RELAY}/v1/systemone`, `Bearer ${INCLUDED}`],
  ] as const)("on Cloud with %s → %s", async (_name, config, provider, url, auth) => {
    cloud();
    const fetchImpl = anyYes();
    await expect(decider(config, fetchImpl).testKey()).resolves.toMatchObject({ ok: true, provider });
    expect(sent(fetchImpl)).toMatchObject({ url, auth });
  });

  it.each([
    ["no Jev or Workers AI key and no Cloud", without("key", "workersAiToken"), "openrouter", `Bearer ${OR_KEY}`],
    ["only the engine's OpenRouter key", without("key", "workersAiToken", "openrouterKey"), "openrouter", `Bearer ${SHARED}`],
  ] as const)("on a desktop with %s → %s", async (_name, config, provider, auth) => {
    const fetchImpl = anyYes();
    await expect(decider(config, fetchImpl).testKey()).resolves.toMatchObject({ ok: true, provider });
    expect(sent(fetchImpl)).toMatchObject({ url: "https://openrouter.ai/api/alpha/decisions", auth });
  });

  it("with no key of any kind there is nothing: off, and never a call", async () => {
    const fetchImpl = anyYes();
    const none: AppConfig = { decider: { enabled: true } };
    expect(deciderAccount(none)).toBeNull();
    expect(deciderReady(none, "inboxTriage")).toBe(false);
    await expect(decider(none, fetchImpl).choose("inboxTriage", {}, { instructions: "x", options: { a: "A", b: "B" } })).resolves.toEqual({ ok: false, reason: "no_key" });
    await expect(decider(none, fetchImpl).testKey()).resolves.toEqual({ ok: false, reason: "no_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an explicit off wins over every key", async () => {
    const fetchImpl = anyYes();
    const off: AppConfig = { decider: { ...all.decider, provider: "off" } };
    expect(deciderReady(off, "roomRouting")).toBe(false);
    await expect(decider(off, fetchImpl).yesNo("botDecide", "x", "Is it?")).resolves.toEqual({ ok: false, reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a Workers AI token without its account ID is no key at all, and saving one is refused", () => {
    expect(deciderAccount({ decider: { enabled: true, workersAiToken: CF_TOKEN } })).toBeNull();
    expect(deciderAccount({ decider: { enabled: true, workersAiToken: CF_TOKEN, workersAiAccountId: "not-an-account" } })).toBeNull();
    expect(deciderSavePatch({ workersAiToken: CF_TOKEN }, {})).toEqual({ ok: false, error: "Add your Cloudflare account ID with the token." });
    expect(deciderSavePatch({ workersAiToken: ` ${CF_TOKEN} `, workersAiAccountId: ` ${ACCOUNT} ` }, {}))
      .toEqual({ ok: true, patch: { workersAiToken: CF_TOKEN, workersAiAccountId: ACCOUNT, enabled: true, jobs: { roomRouting: true } } });
  });

  it("Settings is told which provider is in use, never a key", () => {
    const status = describeDecider(without("key"));
    expect(status).toEqual({ provider: "workersai", configured: true, enabled: true, jobs: { roomRouting: true } });
    expect(JSON.stringify(status)).not.toContain(CF_TOKEN);
  });
});

describe("Clef on Workers AI", () => {
  const config: AppConfig = { decider: { enabled: true, workersAiToken: CF_TOKEN, workersAiAccountId: ACCOUNT } };

  it("sends the documented request and reads the documented answer out of the REST envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(clefWire.response));
    const request = clefWire.request;
    const questions: Record<string, DeciderQuestion> = {
      urgent: { type: "yesno", instructions: request.questions.urgent.instructions },
      team: { type: "choice", instructions: request.questions.team.instructions, options: request.questions.team.criteria },
      severity: { type: "score", instructions: request.questions.severity.instructions, levels: request.questions.severity.criteria },
    };
    expect(clefRequestBody(request.state, questions)).toEqual(request);
    const result = await decider(config, fetchImpl).ask("botDecide", request.state, questions);
    expect(result).toMatchObject({
      ok: true, provider: "workersai", model: "clef-flash", inputTokens: 142,
      answers: { urgent: { type: "yesno", p: 0.94 }, team: { type: "choice", choice: "technical", pTop: 0.95 }, severity: { type: "score", score: 2.6, level: 3 } },
    });
    const call = sent(fetchImpl);
    expect(call).toMatchObject({ url: `${CF_RUN}/clef-flash`, auth: `Bearer ${CF_TOKEN}`, body: request });
    expect(call.seam).toBeUndefined();
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe("error");
  });

  it("a hard case asks Clef, not Clef-flash", async () => {
    const fetchImpl = anyYes();
    await decider(config, fetchImpl).yesNo("botDecide", "x", "Is it?", { careful: true });
    expect(sent(fetchImpl)).toMatchObject({ url: `${CF_RUN}/clef`, body: { model: "clef" } });
  });

  it.each([
    [401, "rejected"], [403, "rejected"], [413, "too_large"], [429, "rate_limited"], [503, "overloaded"], [500, "http_error"],
  ] as const)("HTTP %s → %s, never the body", async (status, reason) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(`echo ${CF_TOKEN}`, { status }));
    const result = await decider(config, fetchImpl).yesNo("botDecide", "x", "Is it?");
    expect(result).toMatchObject({ ok: false, provider: "workersai", reason });
    expect(JSON.stringify(result)).not.toContain(CF_TOKEN);
  });

  it("an envelope that says it failed, or an answer that is not Clef's, is malformed", async () => {
    for (const body of [{ success: false, errors: [{ message: "nope" }], result: null }, { result: { answers: { answer: { type: "noul", noul: 7 } } }, success: true }]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => json(body));
      await expect(decider(config, fetchImpl).yesNo("botDecide", "x", "Is it?")).resolves.toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("the token goes only over https, or plain http to this machine, and only to a well-formed account", () => {
    expect(String(workersAiEndpoint(undefined, ACCOUNT, "clef-flash"))).toBe(`${CF_RUN}/clef-flash`);
    expect(String(workersAiEndpoint("http://127.0.0.1:9/client/v4", ACCOUNT, "clairic"))).toBe(`http://127.0.0.1:9/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clairic`);
    expect(workersAiEndpoint("http://cf.example.com/client/v4", ACCOUNT, "clef")).toBeNull();
    expect(workersAiEndpoint(undefined, "../../other", "clef")).toBeNull();
    expect(workersAiEndpoint("https://user:pw@cf.example.com", ACCOUNT, "clef")).toBeNull();
  });
});

/** The relay sees the wire body; OMB builds it from its own question shape. */
function fromWire(body: { state: unknown; questions: Record<string, { type: string; instructions: string; criteria?: unknown }> }) {
  const questions = Object.fromEntries(Object.entries(body.questions).map(([id, wire]): [string, DeciderQuestion] => {
    if (wire.type === "choice") return [id, { type: "choice", instructions: wire.instructions, options: wire.criteria as Record<string, string> }];
    if (wire.type === "score") return [id, { type: "score", instructions: wire.instructions, levels: wire.criteria as string[] }];
    const criteria = wire.criteria as { true?: string; false?: string } | undefined;
    return [id, { type: "yesno", instructions: wire.instructions, ...(criteria ? { criteria: { ...(criteria.true ? { yes: criteria.true } : {}), ...(criteria.false ? { no: criteria.false } : {}) } } : {}) }];
  }));
  return { state: body.state, questions };
}

describe("the relay's seams, from the fixtures shared with Cloud's Admin", () => {
  it.each(relayFixtures.cases.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
    const { state, questions } = fromWire(fixture.body as never);
    expect(relayAccepts(fixture.seam as DeciderSeam, state, questions)).toBe(fixture.accepts);
    // The fixture is exactly what OMB puts on the wire.
    expect(jevRequestBody(state, questions)).toEqual(fixture.body);
  });

  it("covers every seam the relay takes, accepted and refused", () => {
    for (const seam of ["keyCheck", "roomRouting", "inboxTriage", "botDecide"]) {
      expect(relayFixtures.cases.some((fixture) => fixture.seam === seam && fixture.accepts), seam).toBe(true);
    }
    for (const seam of ["keyCheck", "inboxTriage", "botDecide"]) {
      expect(relayFixtures.cases.some((fixture) => fixture.seam === seam && !fixture.accepts), seam).toBe(true);
    }
    expect(relayFixtures.header).toBe(RELAY_SEAM_HEADER);
  });

  it("through the included token, a request goes with its seam named, and one the relay refuses never goes", async () => {
    cloud();
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ answers: { answer: { type: "choice", choice: "skip", probabilities: { reply: 0.05, important: 0.1, skip: 0.85 } } } }));
    const d = decider({}, fetchImpl);
    const triage = inboxTriageRequest({ email: { from: "news@shop.example", subject: "Deals", preview: "Save 20%" } });
    await expect(d.choose("inboxTriage", triage.state, triage.question)).resolves.toMatchObject({ ok: true, answers: { choice: "skip" } });
    expect(sent(fetchImpl)).toMatchObject({ url: `${RELAY}/v1/systemone`, auth: `Bearer ${INCLUDED}`, seam: "inboxTriage" });
    await d.yesNo("botDecide", "The build is red.", "Is it urgent?");
    expect(sent(fetchImpl, 1)).toMatchObject({ seam: "botDecide" });
    await expect(d.choose("inboxTriage", { ...triage.state, body: "the whole email" }, triage.question)).resolves.toEqual({ ok: false, reason: "misconfigured" });
    await expect(d.yesNo("botDecide", "", "Is it?")).resolves.toEqual({ ok: false, reason: "misconfigured" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("the relay's 413 is too large, said plainly and called once: it is never retried", async () => {
    cloud();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("too big", { status: 413 }));
    await expect(decider({}, fetchImpl).yesNo("botDecide", "x".repeat(20_000), "Is it?")).resolves.toMatchObject({ ok: false, reason: "too_large", status: 413 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an own key never names a seam: the header is the relay's alone", async () => {
    const fetchImpl = anyYes();
    await decider({ decider: { enabled: true, key: JEV_KEY } }, fetchImpl).yesNo("botDecide", "x", "Is it?");
    expect(sent(fetchImpl).seam).toBeUndefined();
  });
});
