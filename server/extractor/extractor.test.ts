// The extraction layer: the shape of its contract (shared with Cloud's Admin through fixtures/), Clairic and Clef on the
// person's own Workers AI account, the relay, the OpenRouter fallback, and whose key is used. No live calls.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import relayFixtures from "./fixtures/extract-relay.json" with { type: "json" };
import workersFixture from "./fixtures/workers-ai-clairic.json" with { type: "json" };
import {
  EXTRACT_LIMITS, extractRequestProblem, INBOX_FIELDS, parseExtractResponse, relayAcceptsExtract,
} from "./contract.ts";
import { createExtractor, describeExtractor, extractorAccount } from "./index.ts";
import { openrouterExtractSchema } from "./remote.ts";
import type { ExtractInput, ExtractSeam, FieldSchema } from "./types.ts";

const CF_TOKEN = "cf_extract_unit_token_0123456789";
const ACCOUNT = "fedcba9876543210fedcba9876543210";
const OR_KEY = "sk-or-v1-extract-unit-0123456789";
const RELAY = "https://cloud.example.test/api/cloud/services/decider";
const INCLUDED = "omb_decide_extract_included_token_0123456789";
const CF_RUN = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare`;
const OWN: AppConfig = { decider: { enabled: true, workersAiToken: CF_TOKEN, workersAiAccountId: ACCOUNT } };
const FIELDS = workersFixture.fields as FieldSchema;
const INPUT = workersFixture.input as ExtractInput;

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const extractor = (config: AppConfig, fetchImpl: FetchMock) => createExtractor({ config: () => config, fetch: fetchImpl as unknown as typeof fetch, timeZone: () => "UTC" });
const sent = (fetchImpl: FetchMock, index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index]!;
  const headers = init!.headers as Record<string, string>;
  return { url: String(url), auth: headers.authorization, body: JSON.parse(String(init!.body)), ...(headers["x-omb-seam"] ? { seam: headers["x-omb-seam"] } : {}) };
};
/** Answers like Workers AI, by model, from the fixture. */
const workersAi = () => vi.fn<typeof fetch>(async (url) => json(String(url).endsWith("/clairic") ? workersFixture.clairic.response : workersFixture.clef.response));
const cloud = () => {
  vi.stubEnv("OMB_CLOUD_DECIDER_URL", RELAY);
  vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", INCLUDED);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the /v1/extract contract, from the fixtures shared with Cloud's Admin", () => {
  it.each(relayFixtures.requests.map((fixture) => [fixture.name, fixture] as const))("request: %s", (_name, fixture) => {
    const { fields, input } = fixture.body as unknown as { fields: FieldSchema; input: ExtractInput };
    expect(relayAcceptsExtract(fixture.seam as ExtractSeam, fields, input)).toBe(fixture.accepts);
  });

  it.each(relayFixtures.responses.map((fixture) => [fixture.name, fixture] as const))("answer: %s", (_name, fixture) => {
    const parsed = parseExtractResponse(fixture.body, fixture.fields as FieldSchema);
    if ("malformed" in fixture) expect(parsed).toBeNull();
    else expect(parsed?.values).toEqual(fixture.values);
  });

  it("the caps the fixtures cannot carry: an image over 1 MB, and a body over 256 KB without its images", () => {
    const image = (bytes: number) => ({ mime: "image/png" as const, data: Buffer.alloc(bytes, 1).toString("base64") });
    const one: FieldSchema = { total: { type: "number" } };
    expect(extractRequestProblem(one, { images: [image(EXTRACT_LIMITS.imageBytes)] })).toBeNull();
    expect(extractRequestProblem(one, { images: [image(EXTRACT_LIMITS.imageBytes + 1)] })).toMatch(/over 1 MB/);
    expect(extractRequestProblem(one, { text: "x".repeat(EXTRACT_LIMITS.text) })).toBeNull();
    expect(extractRequestProblem(one, { text: "x".repeat(EXTRACT_LIMITS.text + 1) })).toMatch(/200000 characters/);
    // 150,000 characters, but 300,000 bytes of UTF-8.
    expect(extractRequestProblem(one, { text: "é".repeat(150_000) })).toMatch(/256 KB/);
  });

  it("inbox triage's fields are the fixtures' exactly", () => {
    expect(relayFixtures.seams.inboxTriage.fields).toEqual(INBOX_FIELDS);
  });
});

describe("Clairic and Clef on the person's own Workers AI account", () => {
  it("string, number and date go to Clairic, boolean and enum to Clef-flash, and the answers merge into typed values", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${workersFixture.referenceDate}T12:00:00Z`));
    const fetchImpl = workersAi();
    const result = await extractor(OWN, fetchImpl).extract("botExtract", FIELDS, INPUT);
    expect(result).toMatchObject({ ok: true, provider: "workersai", values: workersFixture.values, model: "clairic+clef-flash" });
    const calls = [sent(fetchImpl), sent(fetchImpl, 1)].sort((a, b) => a.url.localeCompare(b.url));
    expect(calls[0]).toEqual({ url: `${CF_RUN}/clairic`, auth: `Bearer ${CF_TOKEN}`, body: workersFixture.clairic.request });
    expect(calls[1]).toEqual({ url: `${CF_RUN}/clef-flash`, auth: `Bearer ${CF_TOKEN}`, body: workersFixture.clef.request });
  });

  it("only the model a schema needs is called", async () => {
    const fetchImpl = workersAi();
    await extractor(OWN, fetchImpl).extract("botExtract", { total: { type: "number" } }, INPUT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sent(fetchImpl).url).toBe(`${CF_RUN}/clairic`);
  });

  it("a yes/no Clef is unsure of is null, not a guess", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ result: { answers: { paid: { type: "noul", noul: 0.5 } } }, success: true }));
    await expect(extractor(OWN, fetchImpl).extract("botExtract", { paid: { type: "boolean" } }, INPUT)).resolves.toMatchObject({ ok: true, values: { paid: null } });
  });

  it("images go to both models embedded, never as links", async () => {
    const fetchImpl = workersAi();
    const image = { mime: "image/png" as const, data: "iVBORw0KGgo=" };
    await extractor(OWN, fetchImpl).extract("botExtract", { total: { type: "number" }, paid: { type: "boolean" } }, { images: [image] });
    for (const index of [0, 1]) expect(sent(fetchImpl, index).body.images).toEqual([{ content_type: "image/png", base64: image.data }]);
  });

  it.each([[401, "rejected"], [413, "too_large"], [429, "rate_limited"], [500, "http_error"]] as const)("HTTP %s → %s, and the body is never read", async (status, reason) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(`echo ${CF_TOKEN}`, { status }));
    const result = await extractor(OWN, fetchImpl).extract("botExtract", FIELDS, INPUT);
    expect(result).toMatchObject({ ok: false, provider: "workersai", reason });
    expect(JSON.stringify(result)).not.toContain(CF_TOKEN);
  });

  it("a value of the wrong type is malformed, never passed on", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ result: { answers: { total: { type: "number", value: "1080" } } }, success: true }));
    await expect(extractor(OWN, fetchImpl).extract("botExtract", { total: { type: "number" } }, INPUT)).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("whose key reads: own Workers AI, Cloud's relay, OpenRouter, nothing", () => {
  it("on Cloud, the person's own Workers AI key wins over the relay", async () => {
    cloud();
    const fetchImpl = workersAi();
    await extractor(OWN, fetchImpl).extract("botExtract", { total: { type: "number" } }, INPUT);
    expect(sent(fetchImpl).url).toBe(`${CF_RUN}/clairic`);
  });

  it("with no own key, Cloud's relay gets { seam, fields, input } with the included token", async () => {
    cloud();
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ values: { total: 1080, currency: "USD" }, model: "clairic" }));
    const fields: FieldSchema = { total: { type: "number" }, currency: { type: "enum", options: ["USD", "EUR"] } };
    const result = await extractor({}, fetchImpl).extract("botExtract", fields, INPUT);
    expect(result).toMatchObject({ ok: true, provider: "jev", values: { total: 1080, currency: "USD" }, model: "clairic" });
    expect(sent(fetchImpl)).toEqual({ url: `${RELAY}/v1/extract`, auth: `Bearer ${INCLUDED}`, seam: "botExtract", body: { seam: "botExtract", fields, input: INPUT } });
    expect(describeExtractor({})).toEqual({ provider: "jev", included: true, ready: true });
  });

  it("a request the relay would refuse never goes through the included token", async () => {
    cloud();
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await extractor({}, fetchImpl).extract("inboxTriage", { ...INBOX_FIELDS, body: { type: "string" } }, { text: "x" });
    expect(result).toEqual({ ok: false, reason: "misconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("…and goes to OpenRouter instead when the person has an OpenRouter key", async () => {
    cloud();
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ model: "google/gemini-2.5-flash", choices: [{ message: { content: JSON.stringify({ values: { body: "hi", sender: null, ask: null, deadline: null, amount: null, needs_reply: false, kind: "work" } }) } }] }));
    const config: AppConfig = { decider: { enabled: true, openrouterKey: OR_KEY } };
    const result = await extractor(config, fetchImpl).extract("inboxTriage", { ...INBOX_FIELDS, body: { type: "string" } }, { text: "x" });
    expect(result).toMatchObject({ ok: true, provider: "openrouter" });
    expect(sent(fetchImpl)).toMatchObject({ url: "https://openrouter.ai/api/v1/chat/completions", auth: `Bearer ${OR_KEY}` });
  });

  it("the OpenRouter fallback asks a chat model for strict JSON of exactly the fields, nullable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ choices: [{ message: { content: JSON.stringify({ values: workersFixture.values }) } }] }));
    const config: AppConfig = { openrouter: { key: OR_KEY }, decider: { enabled: true } };
    await expect(extractor(config, fetchImpl).extract("botExtract", FIELDS, INPUT)).resolves.toMatchObject({ ok: true, provider: "openrouter", values: workersFixture.values });
    const { body } = sent(fetchImpl);
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.response_format.json_schema).toMatchObject({ strict: true, schema: openrouterExtractSchema(FIELDS) });
    expect(openrouterExtractSchema(FIELDS).properties.values.properties.currency).toEqual({ type: ["string", "null"], enum: ["USD", "EUR", "GBP", null] });
    expect(body.messages[0].content).toContain("untrusted data");
  });

  it("a Jev key alone cannot extract: Jev only decides", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const config: AppConfig = { decider: { enabled: true, key: "tsk_only_jev" } };
    expect(extractorAccount(config)).toBeNull();
    await expect(extractor(config, fetchImpl).extract("botExtract", FIELDS, INPUT)).resolves.toEqual({ ok: false, reason: "no_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("with no key it says so plainly, and the off switch and the inbox job switch hold", async () => {
    const fetchImpl = workersAi();
    await expect(extractor({}, fetchImpl).extract("botExtract", FIELDS, INPUT)).resolves.toEqual({ ok: false, reason: "disabled" });
    await expect(extractor({ decider: { ...OWN.decider, enabled: false } }, fetchImpl).extract("botExtract", FIELDS, INPUT)).resolves.toEqual({ ok: false, reason: "disabled" });
    await expect(extractor({ decider: { ...OWN.decider, provider: "off" } }, fetchImpl).extract("botExtract", FIELDS, INPUT)).resolves.toEqual({ ok: false, reason: "disabled" });
    await expect(extractor({ decider: { ...OWN.decider, jobs: { inboxTriage: false } } }, fetchImpl).extract("inboxTriage", INBOX_FIELDS, { text: "x" })).resolves.toEqual({ ok: false, reason: "job_off" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the relay's 413 is too large, and is asked once", async () => {
    cloud();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("too big", { status: 413 }));
    await expect(extractor({}, fetchImpl).extract("botExtract", FIELDS, INPUT)).resolves.toMatchObject({ ok: false, reason: "too_large", status: 413 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the key check is one fixed extraction, through the relay too", async () => {
    cloud();
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ values: { ok: true }, model: "clairic" }));
    await expect(extractor({}, fetchImpl).testKey()).resolves.toMatchObject({ ok: true, values: { ok: true } });
    expect(sent(fetchImpl).body).toEqual(relayFixtures.requests.find((fixture) => fixture.seam === "keyCheck" && fixture.accepts)!.body);
  });
});
