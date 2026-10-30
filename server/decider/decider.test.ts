import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createDecider, deciderPatchKey, deciderReady, deciderSavePatch, describeDecider } from "./index.ts";
import { DECIDER_LOG_DIR, flushDeciderLog } from "./log.ts";
import { jevEndpoint, parseJevResponse } from "./jev.ts";
import { KEY_CHECK_QUESTION, KEY_CHECK_STATE, RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import { ROOM_ROUTING_STATE_KEYS, roomRoutingRequest } from "./room-routing.ts";
import type { DeciderJob, DeciderSeam } from "./types.ts";

const KEY = "tsk_unit_secret_key_0123456789abcdef";
const ON: AppConfig = { decider: { enabled: true, key: KEY, jobs: { roomRouting: true } } };
const OPTIONS = { maya: "Maya, Product Designer bot.", theo: "Theo, Frontend Engineer bot." };
const QUESTION = { instructions: "Which bot should answer `new_message`?", options: OPTIONS };
const STATE = { new_message: { from: "Milind", text: "PRIVATE-MESSAGE-TEXT the navbar overlaps on Safari" } };

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function choiceBody(choice: string, probabilities: Record<string, number>) {
  return { model: "jev-1.13.0", answers: { answer: { type: "choice", choice, confidence: 0.9, probabilities } }, usage: { input_tokens: 612 } };
}

function decider(config: AppConfig, fetchImpl: FetchMock, dataDir?: string) {
  return createDecider({ config: () => config, fetch: fetchImpl as unknown as typeof fetch, ...(dataDir ? { dataDir } : {}) });
}

afterEach(() => vi.restoreAllMocks());

describe("decider gates: never a call, never a throw", () => {
  it.each([
    ["the switch is off", { decider: { enabled: false, key: KEY } }, "disabled"],
    ["the decider was never set up", {}, "disabled"],
    ["no key is saved", { decider: { enabled: true, key: "  " } }, "no_key"],
    ["the job is off", { decider: { enabled: true, key: KEY, jobs: { roomRouting: false } } }, "job_off"],
    ["the provider is off", { decider: { enabled: true, key: KEY, provider: "off" } }, "disabled"],
  ] as Array<[string, AppConfig, string]>)("%s → %s", async (_name, config, reason) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await decider(config, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toEqual({ ok: false, reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a config reader that throws still comes back as ok:false", async () => {
    const broken = createDecider({ config: () => { throw new Error("boom"); }, fetch: vi.fn() as unknown as typeof fetch });
    await expect(broken.yesNo("roomRouting", STATE, "Is it?")).resolves.toMatchObject({ ok: false });
  });
});

describe("the request on the wire", () => {
  it("POSTs the bench's working shape: state + model + questions with instructions and criteria", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(choiceBody("theo", { theo: 0.97, maya: 0.03 })));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      state: STATE,
      model: "jev-latest",
      questions: { answer: { type: "choice", instructions: QUESTION.instructions, criteria: OPTIONS } },
    });
  });

  it("sends yes/no as a noul and a score with its levels as criteria", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ answers: { answer: { type: "noul", noul: 0.81 } } }))
      .mockResolvedValueOnce(jsonResponse({ answers: { answer: { type: "score", score: 1.2, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } } } }));
    const d = decider(ON, fetchImpl);
    await expect(d.yesNo("roomRouting", STATE, "Is this about the navbar?")).resolves.toMatchObject({ ok: true, answers: { type: "yesno", p: 0.81 } });
    await expect(d.score("roomRouting", STATE, { instructions: "How hard?", levels: ["easy", "medium", "hard"] }))
      .resolves.toMatchObject({ ok: true, answers: { type: "score", score: 1.2, level: 1 } });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).questions).toEqual({ answer: { type: "noul", instructions: "Is this about the navbar?" } });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)).questions).toEqual({
      answer: { type: "score", instructions: "How hard?", criteria: ["easy", "medium", "hard"] },
    });
  });

  it("bundles several questions into one call and types each answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      answers: { route: { type: "choice", choice: "maya", probabilities: { maya: 0.9, theo: 0.1 } }, urgent: { type: "noul", noul: 0.2 } },
    }));
    const result = await decider(ON, fetchImpl).ask("roomRouting", STATE, {
      route: { type: "choice", instructions: "Who?", options: OPTIONS },
      urgent: { type: "yesno", instructions: "Urgent?" },
    });
    expect(result).toMatchObject({ ok: true, answers: { route: { choice: "maya", pTop: 0.9 }, urgent: { p: 0.2 } } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses a Jev-compatible base URL: https anywhere, http only on this machine", async () => {
    expect(String(jevEndpoint("https://jev.example.com/"))).toBe("https://jev.example.com/v1/systemone");
    expect(String(jevEndpoint("http://127.0.0.1:9911"))).toBe("http://127.0.0.1:9911/v1/systemone");
    expect(jevEndpoint("http://jev.example.com")).toBeNull();
    expect(jevEndpoint("https://user:pw@jev.example.com")).toBeNull();
    const fetchImpl = vi.fn<typeof fetch>();
    const remote = { decider: { ...ON.decider, baseUrl: "http://jev.example.com" } };
    await expect(decider(remote, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "misconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses questions outside the API's limits without calling it", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, `option ${i}`]));
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, { instructions: "?", options: many }))
      .resolves.toMatchObject({ ok: false, reason: "misconfigured" });
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, { instructions: "?", options: { only: "one" } }))
      .resolves.toMatchObject({ ok: false, reason: "misconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("answers are validated strictly", () => {
  it("reports the chosen option, its probability and the margin to the runner-up", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(choiceBody("theo", { theo: 0.94, maya: 0.06 })));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, provider: "jev", inputTokens: 612, model: "jev-1.13.0" });
    if (!result.ok) throw new Error("expected an answer");
    expect(result.answers.choice).toBe("theo");
    expect(result.answers.pTop).toBe(0.94);
    expect(result.answers.margin).toBeCloseTo(0.88);
  });

  it.each([
    ["a choice that was never offered", choiceBody("quinn", { quinn: 1 })],
    ["a probability for an option that was never offered", choiceBody("theo", { theo: 0.9, quinn: 0.1 })],
    ["a probability that is not a number", choiceBody("theo", { theo: "0.9" as unknown as number, maya: 0.1 })],
    ["a probability above one", choiceBody("theo", { theo: 1.5, maya: 0 })],
    ["a negative probability, even when the map sums to one", choiceBody("theo", { theo: 1.2, maya: -0.2 })],
    ["a choice that is not the most likely option", choiceBody("maya", { maya: 0.2, theo: 0.8 })],
    ["probabilities that do not add up", choiceBody("theo", { theo: 0.3, maya: 0.2 })],
    ["no answer for the question", { answers: {} }],
    ["an answer of the wrong type", { answers: { answer: { type: "noul", noul: 0.9 } } }],
    ["no answers at all", { model: "jev-1.13.0" }],
  ])("%s → malformed", async (_name, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a body that is not JSON → malformed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });

  it("yes/no must be a probability", () => {
    const question = { answer: { type: "yesno" as const, instructions: "?" } };
    expect(parseJevResponse({ answers: { answer: { noul: 1.2 } } }, question)).toEqual({ ok: false });
    expect(parseJevResponse({ answers: { answer: { noul: null } } }, question)).toEqual({ ok: false });
    expect(parseJevResponse({ answers: { answer: { noul: 0.4 } } }, question)).toMatchObject({ ok: true });
  });
});

describe("failures come back as reasons", () => {
  it.each([
    [401, "rejected"],
    [403, "rejected"],
    [422, "http_error"],
    [429, "rate_limited"],
    [500, "http_error"],
    [503, "overloaded"],
    [529, "overloaded"],
  ])("HTTP %i → %s", async (status, reason) => {
    // an error body that echoes the key must never surface anywhere
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`bad key ${KEY}`, { status }));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: false, reason, status });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("a network failure → unreachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed for ${KEY}`));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("a slow answer → timeout, within the budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const started = Date.now();
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION, { timeoutMs: 80 });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("a body that stalls after its headers still ends at the budget", async () => {
    const stalled = { ok: true, status: 200, json: () => new Promise(() => undefined), body: null } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stalled);
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION, { timeoutMs: 80 }))
      .resolves.toMatchObject({ ok: false, reason: "timeout" });
  });

  it("the caller's own Stop → cancelled", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION, { signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "cancelled" });
    const already = new AbortController();
    already.abort();
    await expect(decider(ON, vi.fn<typeof fetch>()).choose("roomRouting", STATE, QUESTION, { signal: already.signal }))
      .resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("a fetch that throws synchronously never escapes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => { throw new Error("sync boom"); });
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false });
  });
});

describe("the decision log", () => {
  it("writes one 0600 row per call with no message text and no key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-decider-log-"));
    const logs: string[] = [];
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    }
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(choiceBody("theo", { theo: 0.94, maya: 0.06 })))
      .mockResolvedValueOnce(new Response(`echo ${KEY}`, { status: 529 }));
    const d = decider(ON, fetchImpl, dataDir);
    await d.choose("roomRouting", STATE, QUESTION);
    await d.choose("roomRouting", STATE, QUESTION);
    await decider({ decider: { enabled: false, key: KEY } }, fetchImpl, dataDir).choose("roomRouting", STATE, QUESTION);
    await flushDeciderLog(dataDir);

    const dir = join(dataDir, DECIDER_LOG_DIR);
    const [file] = readdirSync(dir);
    expect(file).toMatch(/^\d{4}-\d{2}\.ndjson$/);
    if (process.platform !== "win32") expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
    const text = readFileSync(join(dir, file!), "utf8");
    const rows = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ seam: "roomRouting", provider: "jev", ok: true, choice: "theo", pTop: 0.94, inputTokens: 612 });
    expect(rows[0].margin).toBeCloseTo(0.88);
    expect(rows[0].stateHash).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof rows[0].latencyMs).toBe("number");
    expect(rows[1]).toMatchObject({ ok: false, reason: "overloaded", status: 529, pTop: null, margin: null });
    expect(text).not.toContain("PRIVATE-MESSAGE-TEXT");
    expect(text).not.toContain("Product Designer");
    expect(text).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });
});

describe("the key check", () => {
  it("tests a draft key whatever the switches say, and the saved key by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ answers: { answer: { type: "noul", noul: 0.97 } } }));
    const off = decider({ decider: { enabled: false, key: KEY } }, fetchImpl);
    await expect(off.testKey({ key: "tsk_draft" })).resolves.toMatchObject({ ok: true, answers: { p: 0.97 } });
    expect(fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({ authorization: "Bearer tsk_draft" });
    await expect(off.testKey()).resolves.toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls[1]![1]?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    await expect(decider({}, fetchImpl).testKey()).resolves.toEqual({ ok: false, reason: "no_key" });
  });
});

describe("settings rules", () => {
  it("saving a key switches the decider and its room job on", () => {
    expect(deciderSavePatch({ key: " tsk_new " }, undefined)).toEqual({ ok: true, patch: { key: "tsk_new", enabled: true, jobs: { roomRouting: true } } });
    expect(deciderSavePatch({ key: "tsk_new" }, { enabled: false, jobs: { roomRouting: false } }))
      .toMatchObject({ ok: true, patch: { enabled: true, jobs: { roomRouting: true } } });
  });

  it("clearing the key switches it off; switching on with no key is refused", () => {
    expect(deciderSavePatch({ key: "" }, { enabled: true, key: KEY })).toEqual({ ok: true, patch: { key: "", enabled: false } });
    expect(deciderSavePatch({ enabled: true }, {})).toMatchObject({ ok: false });
    expect(deciderSavePatch({ enabled: true }, { key: KEY })).toEqual({ ok: true, patch: { enabled: true } });
  });

  it("a job switch merges with the others", () => {
    expect(deciderSavePatch({ jobs: { roomRouting: false } }, { key: KEY, jobs: { roomRouting: true } }))
      .toEqual({ ok: true, patch: { jobs: { roomRouting: false } } });
  });

  it("status is booleans only and the switch reads off while no key is saved", () => {
    expect(describeDecider(ON)).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
    expect(JSON.stringify(describeDecider({ decider: { ...ON.decider, baseUrl: "https://internal.example" } }))).not.toMatch(/tsk_|internal/);
    expect(describeDecider({ decider: { enabled: true } })).toMatchObject({ configured: false, enabled: false });
    expect(deciderReady(ON, "roomRouting")).toBe(true);
    expect(deciderReady({ decider: { ...ON.decider, jobs: { roomRouting: false } } }, "roomRouting")).toBe(false);
    expect(deciderReady({ decider: { enabled: true } }, "roomRouting")).toBe(false);
  });
});

describe("Cloud Pro's included decisions", () => {
  // A Jev base URL whose one relay route is <OMB_CLOUD_DECIDER_URL>/v1/systemone.
  const RELAY = "https://cloud.example.test/api/cloud/services/decider";
  const INCLUDED = "omb_decide_unit_included_token_0123456789";
  const cloudPro = () => {
    vi.stubEnv("OMB_CLOUD_DECIDER_URL", RELAY);
    vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", INCLUDED);
  };
  // The app's real room request: the only one the relay takes besides the key check.
  const ROOM = roomRoutingRequest({
    room: "Launch", humans: ["Milind"],
    members: [{ id: "maya", name: "Maya", title: "Product Designer" }, { id: "theo", name: "Theo", title: "Frontend Engineer" }],
    recent: [{ from: "Milind", text: "PRIVATE-MESSAGE-TEXT we ship Friday" }],
    message: { from: "Milind", text: "PRIVATE-MESSAGE-TEXT the navbar overlaps on Safari" },
  });
  const route = (d: ReturnType<typeof decider>) => d.choose("roomRouting", ROOM.state, ROOM.question);
  const yes = () => vi.fn<typeof fetch>(async () => jsonResponse({ answers: { answer: { type: "noul", noul: 0.97 } } }));
  const theo = () => vi.fn<typeof fetch>(async () => jsonResponse(choiceBody("theo", { theo: 0.97, maya: 0.03 })));
  const sent = (fetchImpl: FetchMock, index = 0) => {
    const [url, init] = fetchImpl.mock.calls[index]!;
    return { url: String(url), auth: (init!.headers as Record<string, string>).authorization };
  };
  afterEach(() => vi.unstubAllEnvs());

  it("with no own key, decides through exactly <OMB_CLOUD_DECIDER_URL>/v1/systemone, on by default", async () => {
    cloudPro();
    const fetchImpl = theo();
    for (const config of [{}, { decider: { baseUrl: "http://127.0.0.1:9" } }] as AppConfig[]) {
      expect(deciderReady(config, "roomRouting")).toBe(true);
      await expect(route(decider(config, fetchImpl))).resolves.toMatchObject({ ok: true, answers: { choice: "theo" } });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) expect(sent(fetchImpl, index)).toEqual({ url: `${RELAY}/v1/systemone`, auth: `Bearer ${INCLUDED}` });
  });

  it("the person's own key wins, and goes only to Jev or their base URL", async () => {
    cloudPro();
    const fetchImpl = theo();
    await route(decider(ON, fetchImpl));
    expect(sent(fetchImpl)).toEqual({ url: "https://api.typesafe.ai/v1/systemone", auth: `Bearer ${KEY}` });
    await route(decider({ decider: { ...ON.decider, baseUrl: "http://127.0.0.1:9" } }, fetchImpl));
    expect(sent(fetchImpl, 1)).toEqual({ url: "http://127.0.0.1:9/v1/systemone", auth: `Bearer ${KEY}` });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(INCLUDED);
    expect(describeDecider(ON)).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
  });

  it("an own key is on only once switched on, as without Cloud Pro", async () => {
    cloudPro();
    const fetchImpl = theo();
    const unswitched: AppConfig = { decider: { key: KEY } };
    expect(deciderReady(unswitched, "roomRouting")).toBe(false);
    await expect(route(decider(unswitched, fetchImpl))).resolves.toEqual({ ok: false, reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an explicit off wins, and a job switched off stays off", async () => {
    cloudPro();
    const fetchImpl = theo();
    const off: AppConfig = { decider: { enabled: false } };
    expect(describeDecider(off)).toEqual({ provider: "jev", configured: true, included: true, enabled: false, jobs: { roomRouting: true } });
    expect(deciderReady(off, "roomRouting")).toBe(false);
    await expect(route(decider(off, fetchImpl))).resolves.toEqual({ ok: false, reason: "disabled" });
    const jobOff: AppConfig = { decider: { jobs: { roomRouting: false } } };
    expect(deciderReady(jobOff, "roomRouting")).toBe(false);
    await expect(route(decider(jobOff, fetchImpl))).resolves.toEqual({ ok: false, reason: "job_off" });
    await expect(route(decider({ decider: { provider: "off" } }, fetchImpl))).resolves.toEqual({ ok: false, reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is on by default only while included: without the relay's URL and token nothing changes", async () => {
    const fetchImpl = theo();
    for (const env of [{}, { OMB_CLOUD_DECIDER_TOKEN: INCLUDED }, { OMB_CLOUD_DECIDER_URL: RELAY }]) {
      vi.unstubAllEnvs();
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      expect(describeDecider({})).toEqual({ provider: "jev", configured: false, enabled: false, jobs: { roomRouting: true } });
      expect(deciderReady({}, "roomRouting")).toBe(false);
      await expect(route(decider({}, fetchImpl))).resolves.toEqual({ ok: false, reason: "disabled" });
      await expect(decider({}, fetchImpl).testKey()).resolves.toEqual({ ok: false, reason: "no_key" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Settings sees it as included and never sees the token", () => {
    cloudPro();
    const status = describeDecider({});
    expect(status).toEqual({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    expect(JSON.stringify(status)).not.toContain(INCLUDED);
  });

  it("Test checks the relay with its one fixed call; a draft key goes only to Jev", async () => {
    cloudPro();
    const fetchImpl = yes();
    const d = decider({ decider: { enabled: false } }, fetchImpl);
    await expect(d.testKey()).resolves.toMatchObject({ ok: true, answers: { p: 0.97 } });
    expect(sent(fetchImpl)).toEqual({ url: `${RELAY}/v1/systemone`, auth: `Bearer ${INCLUDED}` });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({
      state: KEY_CHECK_STATE, model: "jev-latest", questions: { answer: { type: "noul", instructions: KEY_CHECK_QUESTION } },
    });
    await expect(d.testKey({ key: "tsk_draft" })).resolves.toMatchObject({ ok: true });
    expect(sent(fetchImpl, 1)).toEqual({ url: "https://api.typesafe.ai/v1/systemone", auth: "Bearer tsk_draft" });
  });

  it("sends nothing but the relay's two requests through the included token; an own key sends them to Jev", async () => {
    cloudPro();
    const fetchImpl = theo();
    const huge = "x".repeat(RELAY_MAX_STATE_BYTES);
    const refused: Array<[string, unknown, Record<string, unknown>]> = [
      ["other instructions", ROOM.state, { answer: { type: "choice", instructions: "Which bot?", options: ROOM.question.options } }],
      ["a second question", ROOM.state, { answer: { type: "choice", ...ROOM.question }, extra: { type: "yesno", instructions: "And?" } }],
      ["another question id", ROOM.state, { pick: { type: "choice", ...ROOM.question } }],
      ["a yes/no in the room seam", ROOM.state, { answer: { type: "yesno", instructions: ROOM.question.instructions } }],
      ["an extra state key", { ...ROOM.state, files: ["~/.ssh/id_ed25519"] }, { answer: { type: "choice", ...ROOM.question } }],
      ["a missing state key", { room: "Launch", new_message: ROOM.state.new_message }, { answer: { type: "choice", ...ROOM.question } }],
      ["text as state", "the navbar overlaps", { answer: { type: "choice", ...ROOM.question } }],
      ["a state over 24,000 bytes", { ...ROOM.state, new_message: { from: "Milind", text: huge } }, { answer: { type: "choice", ...ROOM.question } }],
      ["a body over 64 KiB", ROOM.state, { answer: { type: "choice", instructions: ROOM.question.instructions, options: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`bot${i}`, "y".repeat(400)])) } }],
    ];
    for (const [name, state, questions] of refused) {
      const result = await decider({}, fetchImpl).ask("roomRouting", state, questions as never);
      expect(result, name).toEqual({ ok: false, reason: "misconfigured" });
      await decider(ON, fetchImpl).ask("roomRouting", state, questions as never);
    }
    expect(fetchImpl.mock.calls.every(([url, init]) =>
      String(url) === "https://api.typesafe.ai/v1/systemone" && (init!.headers as Record<string, string>).authorization === `Bearer ${KEY}`)).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
  });

  it("a job the relay does not take uses only an own key", async () => {
    cloudPro();
    const fetchImpl = theo();
    const later = "toolSelection" as DeciderJob;
    expect(deciderReady({}, later)).toBe(false);
    await expect(decider({}, fetchImpl).choose(later, STATE, QUESTION)).resolves.toEqual({ ok: false, reason: "no_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deciderReady(ON, later)).toBe(true);
    await expect(decider(ON, fetchImpl).choose(later, STATE, QUESTION)).resolves.toMatchObject({ ok: true });
    expect(sent(fetchImpl)).toEqual({ url: "https://api.typesafe.ai/v1/systemone", auth: `Bearer ${KEY}` });
  });

  it("the app's real room request fits the relay, even for a busy room with a long message", () => {
    expect(relayAccepts("roomRouting", ROOM.state, { answer: { type: "choice", ...ROOM.question } })).toBe(true);
    const busy = roomRoutingRequest({
      room: "r".repeat(200), humans: Array.from({ length: 12 }, (_, i) => `Person ${i} ${"p".repeat(90)}`),
      members: Array.from({ length: 24 }, (_, i) => ({ id: `bot-${i}`, name: `Bot ${i}`, title: "t".repeat(200), description: "d".repeat(900) })),
      recent: Array.from({ length: 40 }, (_, i) => ({ from: `Person ${i}`, text: "m".repeat(700) })),
      message: { from: "Milind", text: "n".repeat(7_000) },
    });
    expect(Object.keys(busy.state).every((key) => (ROOM_ROUTING_STATE_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(relayAccepts("roomRouting", busy.state, { answer: { type: "choice", ...busy.question } })).toBe(true);
    expect(relayAccepts("keyCheck", KEY_CHECK_STATE, { answer: { type: "yesno", instructions: KEY_CHECK_QUESTION } })).toBe(true);
    expect(relayAccepts("keyCheck", { purpose: "other" }, { answer: { type: "yesno", instructions: KEY_CHECK_QUESTION } })).toBe(false);
    expect(relayAccepts("keyCheck", KEY_CHECK_STATE, { answer: { type: "yesno", instructions: "Is it?" } })).toBe(false);
    expect(relayAccepts("toolSelection" as DeciderSeam, ROOM.state, { answer: { type: "choice", ...ROOM.question } })).toBe(false);
  });

  it.each([
    [401, "rejected"],
    [402, "http_error"],
    [429, "rate_limited"],
    [502, "http_error"],
    [503, "overloaded"],
  ])("a relay refusal (HTTP %i) is a fallback reason, never a throw", async (status, reason) => {
    cloudPro();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { type: "quota_exceeded", message: `used up ${INCLUDED}` } }), { status }));
    const result = await route(decider({}, fetchImpl));
    expect(result).toMatchObject({ ok: false, reason, status });
    expect(JSON.stringify(result)).not.toContain(INCLUDED);
  });

  it("the decision log never holds the token", async () => {
    cloudPro();
    const dataDir = mkdtempSync(join(tmpdir(), "omb-decider-included-log-"));
    await route(decider({}, theo(), dataDir));
    await flushDeciderLog(dataDir);
    const dir = join(dataDir, DECIDER_LOG_DIR);
    const log = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("");
    expect(log).toContain('"ok":true');
    expect(log).not.toContain(INCLUDED);
    expect(log).not.toContain("cloud.example.test");
  });

  it("clearing an own key falls back to the included decisions as they stand; switching on needs no key", () => {
    expect(deciderSavePatch({ key: "" }, { enabled: true, key: KEY }, { included: true })).toEqual({ ok: true, patch: { key: "" } });
    expect(deciderSavePatch({ enabled: true }, {}, { included: true })).toEqual({ ok: true, patch: { enabled: true } });
    expect(deciderSavePatch({ enabled: false }, {}, { included: true })).toEqual({ ok: true, patch: { enabled: false } });
    expect(deciderSavePatch({ key: "tsk_new" }, { enabled: false }, { included: true })).toEqual({ ok: true, patch: { key: "tsk_new", enabled: true, jobs: { roomRouting: true } } });
    expect(deciderSavePatch({ key: "" }, { enabled: true, key: KEY }, { included: false })).toEqual({ ok: true, patch: { key: "", enabled: false } });
    expect(deciderSavePatch({ enabled: true }, {}, { included: false })).toMatchObject({ ok: false });
  });
});

describe("OpenRouter as the provider", () => {
  const OR_KEY = "sk-or-v1-unit-openrouter-key-0123456789";
  const OR: AppConfig = { decider: { enabled: true, provider: "openrouter", openrouterKey: OR_KEY, openrouterModel: "openai/gpt-4o-mini", jobs: { roomRouting: true } } };
  const answer = (choice: string, probabilities: Record<string, number>) => new Response(JSON.stringify({
    model: "openai/gpt-4o-mini",
    choices: [{ message: { content: JSON.stringify({ answers: { answer: { choice, probabilities } } }) } }],
    usage: { prompt_tokens: 300 },
  }), { status: 200 });
  const yes = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ answers: { answer: { noul: 0.97 } } }) } }],
  }), { status: 200 }));
  const authOf = (fetchImpl: FetchMock, index = 0) => (fetchImpl.mock.calls[index]![1]!.headers as Record<string, string>).authorization;
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["the switch is off", { decider: { ...OR.decider, enabled: false } }, "disabled"],
    ["no key is saved at all", { decider: { ...OR.decider, openrouterKey: " " } }, "no_key"],
    ["the job is off", { decider: { ...OR.decider, jobs: { roomRouting: false } } }, "job_off"],
  ] as Array<[string, AppConfig, string]>)("%s → %s, with no call", async (_name, config, reason) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(decider(config, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toEqual({ ok: false, reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("goes to OpenRouter with its own key and model", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer("theo", { theo: 0.9, maya: 0.1 }));
    const result = await decider(OR, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, provider: "openrouter", model: "openai/gpt-4o-mini", inputTokens: 300 });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authOf(fetchImpl)).toBe(`Bearer ${OR_KEY}`);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe("openai/gpt-4o-mini");
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(KEY);
  });

  it("a configured OpenRouter base URL carries the key, and a Jev base URL never does", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer("theo", { theo: 0.9, maya: 0.1 }));
    await decider({ decider: { ...OR.decider, openrouterBaseUrl: "http://127.0.0.1:9/v1", baseUrl: "https://jev.example.com" } }, fetchImpl)
      .choose("roomRouting", STATE, QUESTION);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://127.0.0.1:9/v1/chat/completions");
  });

  it("logs the provider and model, with no message text and no key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-decider-or-log-"));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(answer("theo", { theo: 0.9, maya: 0.1 }))
      .mockResolvedValueOnce(new Response(`echo ${OR_KEY}`, { status: 402 }));
    const d = decider(OR, fetchImpl, dataDir);
    await d.choose("roomRouting", STATE, QUESTION);
    await d.choose("roomRouting", STATE, QUESTION);
    await flushDeciderLog(dataDir);
    const dir = join(dataDir, DECIDER_LOG_DIR);
    const text = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("");
    const rows = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({ seam: "roomRouting", provider: "openrouter", model: "openai/gpt-4o-mini", ok: true, choice: "theo", pTop: 0.9, inputTokens: 300 });
    expect(rows[1]).toMatchObject({ provider: "openrouter", model: "openai/gpt-4o-mini", ok: false, reason: "http_error", status: 402 });
    for (const secret of ["PRIVATE-MESSAGE-TEXT", "Product Designer", OR_KEY]) expect(text).not.toContain(secret);
  });

  it("a Jev log row stays without a model", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-decider-jev-log-"));
    await decider(ON, vi.fn<typeof fetch>(async () => jsonResponse(choiceBody("theo", { theo: 0.94, maya: 0.06 }))), dataDir).choose("roomRouting", STATE, QUESTION);
    await flushDeciderLog(dataDir);
    const dir = join(dataDir, DECIDER_LOG_DIR);
    const [row] = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(row.provider).toBe("jev");
    expect(row).not.toHaveProperty("model");
  });

  it("Cloud's included relay comes before OpenRouter, and its token never goes to OpenRouter", async () => {
    const relay = "https://cloud.example.test/api/cloud/services/decider";
    vi.stubEnv("OMB_CLOUD_DECIDER_URL", relay);
    vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", "omb_decide_unit_included_token_0123456789");
    const fetchImpl = yes();
    const chose: AppConfig = { decider: { ...OR.decider } };
    expect(describeDecider(chose)).toEqual({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
    await decider(chose, fetchImpl).testKey();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${relay}/v1/systemone`);
    // A job the relay does not take falls through to OpenRouter, with the person's own OpenRouter key only.
    await decider(chose, fetchImpl).testKey({ provider: "openrouter" });
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authOf(fetchImpl, 1)).toBe(`Bearer ${OR_KEY}`);
  });

  it("Settings status names the provider and the model in use, and never a key", () => {
    const status = describeDecider(OR);
    expect(status).toEqual({ provider: "openrouter", model: "openai/gpt-4o-mini", api: "chat", configured: true, keySource: "own", enabled: true, jobs: { roomRouting: true } });
    expect(JSON.stringify(status)).not.toContain(OR_KEY);
    expect(describeDecider({ decider: { enabled: true, provider: "openrouter", key: KEY } })).toMatchObject({ provider: "jev", configured: true, enabled: true });
    expect(describeDecider({ decider: { enabled: true, key: KEY } })).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
  });

  describe("the OpenRouter key from Settings → API keys", () => {
    const SHARED_KEY = "sk-or-v1-unit-shared-key-0123456789";
    const shared = (decider: NonNullable<AppConfig["decider"]> = {}): AppConfig => ({
      openrouter: { key: SHARED_KEY },
      decider: { enabled: true, provider: "openrouter", openrouterModel: "openai/gpt-4o-mini", ...decider },
    });

    it("is used when the decision model has no key of its own", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => answer("theo", { theo: 0.9, maya: 0.1 }));
      await expect(decider(shared(), fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: true, provider: "openrouter" });
      expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(authOf(fetchImpl)).toBe(`Bearer ${SHARED_KEY}`);
      expect(deciderReady(shared(), "roomRouting")).toBe(true);
    });

    it("loses to a saved decision-model key, which also keeps a blank one from hiding it", async () => {
      const fetchImpl = yes();
      await decider(shared({ openrouterKey: OR_KEY }), fetchImpl).testKey();
      expect(authOf(fetchImpl)).toBe(`Bearer ${OR_KEY}`);
      await decider(shared({ openrouterKey: "  " }), fetchImpl).testKey();
      expect(authOf(fetchImpl, 1)).toBe(`Bearer ${SHARED_KEY}`);
      await decider(shared(), fetchImpl).testKey({ key: "sk-or-draft" });
      expect(authOf(fetchImpl, 2)).toBe("Bearer sk-or-draft");
      expect(JSON.stringify(fetchImpl.mock.calls.slice(0, 1))).not.toContain(SHARED_KEY);
    });

    it("with no key of either kind there is nothing to use", async () => {
      const fetchImpl = yes();
      const none: AppConfig = { openrouter: { key: " " }, decider: { enabled: true, provider: "openrouter" } };
      expect(deciderReady(none, "roomRouting")).toBe(false);
      await expect(decider(none, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toEqual({ ok: false, reason: "no_key" });
      await expect(decider(none, fetchImpl).testKey()).resolves.toEqual({ ok: false, reason: "no_key" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("never goes to an operator's base URL, which only an own key may use", async () => {
      const fetchImpl = yes();
      const elsewhere = { openrouterBaseUrl: "http://127.0.0.1:9/v1" };
      expect(deciderReady(shared(elsewhere), "roomRouting")).toBe(false);
      await expect(decider(shared(elsewhere), fetchImpl).testKey()).resolves.toEqual({ ok: false, reason: "no_key" });
      expect(fetchImpl).not.toHaveBeenCalled();
      await decider(shared({ ...elsewhere, openrouterKey: OR_KEY }), fetchImpl).testKey();
      expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://127.0.0.1:9/v1/chat/completions");
      expect(authOf(fetchImpl)).toBe(`Bearer ${OR_KEY}`);
      await decider(shared({ openrouterBaseUrl: "https://openrouter.ai/api/v1" }), fetchImpl).testKey();
      expect(authOf(fetchImpl, 1)).toBe(`Bearer ${SHARED_KEY}`);
    });

    it("is not the Jev provider's key", async () => {
      const fetchImpl = yes();
      const jev: AppConfig = { openrouter: { key: SHARED_KEY }, decider: { enabled: true, key: KEY } };
      await decider(jev, fetchImpl).testKey();
      expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.typesafe.ai/v1/systemone");
      expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(SHARED_KEY);
      expect(describeDecider(jev)).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
      // With no key of the decider's own, the engine's OpenRouter key is the fallback.
      expect(describeDecider({ openrouter: { key: SHARED_KEY }, decider: { enabled: true } })).toMatchObject({ provider: "openrouter", configured: true, keySource: "shared" });
    });

    it("status says which key is in use and whether a shared one is on file, never the key", () => {
      const status = (config: AppConfig) => describeDecider(config);
      expect(status(shared())).toEqual({
        provider: "openrouter", model: "openai/gpt-4o-mini", api: "chat", configured: true, keySource: "shared", sharedKey: true, enabled: true, jobs: { roomRouting: true },
      });
      expect(status(shared({ openrouterKey: OR_KEY }))).toMatchObject({ configured: true, keySource: "own", sharedKey: true });
      expect(status({ decider: { enabled: true, provider: "openrouter", openrouterKey: OR_KEY } })).toMatchObject({ configured: true, keySource: "own" });
      expect(status({ decider: { enabled: true, provider: "openrouter", openrouterKey: OR_KEY } })).not.toHaveProperty("sharedKey");
      const none = status({ decider: { provider: "openrouter" } });
      expect(none).toMatchObject({ configured: false, enabled: false });
      expect(none).not.toHaveProperty("keySource");
      expect(none).not.toHaveProperty("sharedKey");
      expect(status(shared({ openrouterBaseUrl: "http://127.0.0.1:9/v1" }))).toMatchObject({ configured: false, enabled: false });
      expect(JSON.stringify([status(shared()), status(shared({ openrouterKey: OR_KEY }))])).not.toMatch(/sk-or-v1/);
      expect(status(shared({ enabled: false }))).toMatchObject({ configured: true, enabled: false });
    });

    it("switching on needs no decision-model key, and clearing the own one keeps it on", () => {
      const fallback = { shared: true };
      expect(deciderSavePatch({ enabled: true }, { provider: "openrouter" }, fallback)).toEqual({ ok: true, patch: { enabled: true } });
      expect(deciderSavePatch({ provider: "openrouter", enabled: true }, undefined, fallback)).toEqual({ ok: true, patch: { provider: "openrouter", enabled: true } });
      expect(deciderSavePatch({ openrouterKey: "" }, { provider: "openrouter", enabled: true, openrouterKey: OR_KEY }, fallback))
        .toEqual({ ok: true, patch: { openrouterKey: "" } });
      expect(deciderSavePatch({ provider: "openrouter" }, { provider: "jev", enabled: false }, fallback)).toEqual({ ok: true, patch: { provider: "openrouter" } });
      expect(deciderSavePatch({ openrouterKey: "sk-or-new" }, { provider: "openrouter", enabled: false }, fallback))
        .toMatchObject({ ok: true, patch: { enabled: true, jobs: { roomRouting: true } } });
      expect(deciderSavePatch({ enabled: true }, { provider: "openrouter" }, {})).toMatchObject({ ok: false });
      expect(deciderSavePatch({ openrouterKey: "" }, { provider: "openrouter", enabled: true, openrouterKey: OR_KEY }, {}))
        .toEqual({ ok: true, patch: { openrouterKey: "", enabled: false } });
      expect(deciderSavePatch({ enabled: true }, { key: KEY }, fallback)).toMatchObject({ ok: true });
      expect(deciderSavePatch({ enabled: true }, {}, fallback)).toMatchObject({ ok: true });
      expect(deciderSavePatch({ enabled: true }, {}, {})).toMatchObject({ ok: false, error: expect.stringContaining("Workers AI") });
    });
  });

  it("Test checks a draft or the saved key at OpenRouter with the chosen model", async () => {
    const fetchImpl = yes();
    const d = decider({ decider: { ...OR.decider, enabled: false } }, fetchImpl);
    await expect(d.testKey({ key: "sk-or-draft" })).resolves.toMatchObject({ ok: true, provider: "openrouter", answers: { p: 0.97 } });
    expect(authOf(fetchImpl)).toBe("Bearer sk-or-draft");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe("openai/gpt-4o-mini");
    await expect(d.testKey()).resolves.toMatchObject({ ok: true });
    expect(authOf(fetchImpl, 1)).toBe(`Bearer ${OR_KEY}`);
  });

  it("Test can override the provider and model, as a save that changes them with the key needs", async () => {
    const fetchImpl = yes();
    const d = decider(ON, fetchImpl);
    await d.testKey({ key: "sk-or-draft", provider: "openrouter", model: "meta-llama/llama-4-maverick" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe("meta-llama/llama-4-maverick");
    await decider(OR, fetchImpl).testKey({ key: "tsk_draft", provider: "jev" });
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://api.typesafe.ai/v1/systemone");
    expect(authOf(fetchImpl, 1)).toBe("Bearer tsk_draft");
  });
});

describe("settings rules with two providers", () => {
  it("saving the OpenRouter key switches the decider and its room job on", () => {
    expect(deciderSavePatch({ provider: "openrouter", openrouterKey: " sk-or-new " }, undefined))
      .toEqual({ ok: true, patch: { provider: "openrouter", openrouterKey: "sk-or-new", enabled: true, jobs: { roomRouting: true } } });
    expect(deciderSavePatch({ openrouterKey: "sk-or-new" }, { provider: "openrouter", enabled: false, jobs: { roomRouting: false } }))
      .toMatchObject({ ok: true, patch: { enabled: true, jobs: { roomRouting: true } } });
  });

  it("clearing the last own key keeps it on only where something else answers: Cloud's relay or the engine's OpenRouter key", () => {
    expect(deciderSavePatch({ openrouterKey: "" }, { provider: "openrouter", enabled: true, openrouterKey: "sk-or" }, { included: true }))
      .toEqual({ ok: true, patch: { openrouterKey: "" } });
    expect(deciderSavePatch({ openrouterKey: "" }, { provider: "openrouter", enabled: true, openrouterKey: "sk-or" }))
      .toEqual({ ok: true, patch: { openrouterKey: "", enabled: false } });
  });

  it("any key saved switches it on; clearing one while another is on file leaves the switch alone", () => {
    expect(deciderSavePatch({ key: " tsk_new " }, { provider: "openrouter", enabled: false })).toEqual({ ok: true, patch: { key: "tsk_new", enabled: true, jobs: { roomRouting: true } } });
    expect(deciderSavePatch({ openrouterKey: "sk-or" }, { enabled: false, key: KEY })).toEqual({ ok: true, patch: { openrouterKey: "sk-or", enabled: true, jobs: { roomRouting: true } } });
    expect(deciderSavePatch({ openrouterKey: "" }, { enabled: true, key: KEY })).toEqual({ ok: true, patch: { openrouterKey: "" } });
  });

  it("a provider-only patch never errors and leaves the switch alone", () => {
    expect(deciderSavePatch({ provider: "openrouter" }, { enabled: true, key: KEY })).toEqual({ ok: true, patch: { provider: "openrouter" } });
    expect(deciderSavePatch({ provider: "jev" }, { provider: "openrouter", enabled: true })).toEqual({ ok: true, patch: { provider: "jev" } });
    expect(deciderSavePatch({ openrouterModel: "openai/gpt-4o-mini" }, { provider: "openrouter" })).toEqual({ ok: true, patch: { openrouterModel: "openai/gpt-4o-mini", openrouterApi: "chat" } });
    expect(deciderSavePatch({ openrouterModel: "typesafe/jev-1.13", openrouterApi: "decisions" }, { provider: "openrouter" }))
      .toEqual({ ok: true, patch: { openrouterModel: "typesafe/jev-1.13", openrouterApi: "decisions" } });
  });

  it("switching on needs some key, and the error names every kind", () => {
    expect(deciderSavePatch({ provider: "openrouter", enabled: true }, { enabled: false, key: KEY })).toEqual({ ok: true, patch: { provider: "openrouter", enabled: true } });
    expect(deciderSavePatch({ enabled: true }, { provider: "openrouter", openrouterKey: "sk-or" })).toEqual({ ok: true, patch: { enabled: true } });
    expect(deciderSavePatch({ enabled: true }, {})).toEqual({ ok: false, error: "Save a Cloudflare Workers AI, Jev or OpenRouter key before turning on fast decisions." });
    expect(deciderSavePatch({ enabled: true }, { workersAiToken: "cf-token" })).toMatchObject({ ok: false });
    expect(deciderSavePatch({ provider: "openrouter", enabled: true }, {}, { included: true })).toMatchObject({ ok: true });
  });

  it("picks the pasted key to check: the active provider's, with the model it will use", () => {
    expect(deciderPatchKey({ key: " tsk_new " }, undefined)).toEqual({ provider: "jev", check: { key: "tsk_new", provider: "jev" } });
    expect(deciderPatchKey({ provider: "openrouter", openrouterKey: "sk-or" }, undefined))
      .toEqual({ provider: "openrouter", check: { key: "sk-or", provider: "openrouter", model: "typesafe/jev-1.13", api: "decisions" } });
    expect(deciderPatchKey({ openrouterKey: "sk-or" }, { provider: "openrouter", openrouterModel: "typesafe/jev-1.13", openrouterApi: "decisions" }))
      .toMatchObject({ check: { model: "typesafe/jev-1.13", api: "decisions" } });
    expect(deciderPatchKey({ openrouterKey: "sk-or" }, { provider: "openrouter", openrouterModel: "openai/gpt-4o-mini" }))
      .toMatchObject({ provider: "openrouter", check: { model: "openai/gpt-4o-mini" } });
    expect(deciderPatchKey({ key: "tsk_new" }, { provider: "openrouter" })).toMatchObject({ provider: "jev" });
    expect(deciderPatchKey({ key: "  ", openrouterKey: "" }, undefined)).toBeNull();
    expect(deciderPatchKey({ enabled: true }, undefined)).toBeNull();
  });
});
