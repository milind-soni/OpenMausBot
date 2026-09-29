// The decision-model connection (issue #1630) at the unit level: the
// configuration gate (what counts as off), the wire dialects the lanes
// speak, and the calibration probe the Settings Test button runs. The
// probe is the security boundary for confidence-based acting, so its
// verdict table — right answer, stable distribution, summed
// probabilities — is pinned here against scripted servers.
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DECISION_THRESHOLD,
  createCalibrationGate,
  decisionModelBaseUrl,
  decisionModelConfigured,
  decisionThreshold,
  probeDecisionModel,
} from "./decision-model.ts";

const CANARY_PROBABILITIES = { two: 0.97, three: 0.01, seventeen: 0.01, reobserve: 0.005, abstain: 0.005 };

function systemOneBody(answer: Record<string, unknown>, model = "jev-latest") {
  return { model, usage: { input_tokens: 12, output_tokens: 4 }, answers: { next_action: { type: "choice", ...answer } } };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number) => new Response("{}", { status: code, headers: { "content-type": "application/json" } });

describe("decision model configuration", () => {
  it("treats an absent or incomplete section as off", () => {
    expect(decisionModelConfigured(undefined)).toBe(false);
    expect(decisionModelConfigured({ provider: "typesafe" })).toBe(false);
    expect(decisionModelConfigured({ provider: "typesafe", model: "jev-latest" })).toBe(false);
    expect(decisionModelConfigured({ provider: "typesafe", model: "jev-latest", apiKey: " " })).toBe(false);
    expect(decisionModelConfigured({ provider: "custom", model: "local", url: "http://127.0.0.1:8000/v1" })).toBe(true);
    expect(decisionModelConfigured({ provider: "custom", model: "local" })).toBe(false);
  });

  it("resolves each lane's base URL and never invents one for custom", () => {
    expect(decisionModelBaseUrl({ provider: "typesafe", model: "m" })).toBe("https://api.typesafe.ai");
    expect(decisionModelBaseUrl({ provider: "vercel", model: "m" })).toBe("https://ai-gateway.vercel.sh/v1");
    expect(decisionModelBaseUrl({ provider: "openrouter", model: "m" })).toBe("https://openrouter.ai/api/v1");
    expect(decisionModelBaseUrl({ provider: "custom", model: "m" })).toBe(null);
    expect(decisionModelBaseUrl({ provider: "custom", model: "m", url: "http://127.0.0.1:8787/v1/" })).toBe("http://127.0.0.1:8787/v1");
    expect(decisionModelBaseUrl({ provider: "custom", model: "m", url: "ftp://example.test" })).toBe(null);
  });

  it("defaults the threshold and clamps out-of-range values", () => {
    expect(decisionThreshold(undefined)).toBe(DEFAULT_DECISION_THRESHOLD);
    expect(DEFAULT_DECISION_THRESHOLD).toBe(0.9);
    expect(decisionThreshold({ provider: "typesafe", threshold: 0.75 })).toBe(0.75);
    expect(decisionThreshold({ provider: "typesafe", threshold: 0.2 })).toBe(0.9);
    expect(decisionThreshold({ provider: "typesafe", threshold: 1.5 })).toBe(0.9);
  });
});

describe("probeDecisionModel (systemone lanes)", () => {
  const config = { provider: "typesafe" as const, url: "https://api.test", apiKey: "tsk-secret", model: "jev-latest" };

  it("passes a deterministic calibrated canary without leaking the key into a body", async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return ok(systemOneBody({ choice: "two", confidence: 0.97, probabilities: CANARY_PROBABILITIES }));
    });
    const verdict = await probeDecisionModel(config, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ ok: true, check: "calibration", model: "jev-latest", confidence: 0.97, deterministic: true });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://api.test/v1/systemone");
      expect(call.headers.get("authorization")).toBe("Bearer tsk-secret");
      expect(JSON.stringify(call.body)).not.toContain("tsk-secret");
      expect((call.body as { model: string }).model).toBe("jev-latest");
    }
  });

  it("fails a server that picks the wrong candidate", async () => {
    const fetchImpl = vi.fn(async () => ok(systemOneBody({ choice: "seventeen", confidence: 0.9, probabilities: { ...CANARY_PROBABILITIES, two: 0.01, seventeen: 0.97 } })));
    await expect(probeDecisionModel(config, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({ ok: false, reason: "uncalibrated" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails a wrapper whose numbers move between identical requests", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      const two = n === 1 ? 0.97 : 0.91;
      const three = n === 1 ? 0.01 : 0.07;
      return ok(systemOneBody({ choice: "two", confidence: two, probabilities: { ...CANARY_PROBABILITIES, two, three } }));
    });
    await expect(probeDecisionModel(config, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      ok: false,
      reason: "uncalibrated",
      detail: expect.stringContaining("different distributions"),
    });
  });

  it("fails a wrapper whose confidence moves between identical requests", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return ok(systemOneBody({ choice: "two", confidence: n === 1 ? 0.97 : 0.42, probabilities: CANARY_PROBABILITIES }));
    });
    await expect(probeDecisionModel(config, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      ok: false,
      reason: "uncalibrated",
      detail: expect.stringContaining("different confidence"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps an auth failure to rejected without a second call", async () => {
    const fetchImpl = vi.fn(async () => status(401));
    await expect(probeDecisionModel(config, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({ ok: false, reason: "rejected", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers an incomplete connection before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(probeDecisionModel({ provider: "custom", model: "m" }, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      ok: false, reason: "uncalibrated", detail: expect.stringContaining("incomplete"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("probeDecisionModel (custom lane)", () => {
  const config = { provider: "custom" as const, url: "http://127.0.0.1:8787/v1", model: "local-classifier" };

  const chat = (decision: unknown) =>
    ok({ choices: [{ message: { content: JSON.stringify(decision) } }] });

  it("speaks chat/completions and validates the envelope", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return chat({ choice: "two", confidence: 0.96, probabilities: CANARY_PROBABILITIES });
    });
    const verdict = await probeDecisionModel(config, fetchImpl as unknown as typeof fetch);
    expect(verdict).toMatchObject({ ok: true, check: "calibration", confidence: 0.96, deterministic: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/v1/chat/completions");
    expect(calls[0]!.body.temperature).toBe(0);
    expect(calls[0]!.body.response_format.type).toBe("json_schema");
  });

  it("fails a wrong candidate", async () => {
    const fetchImpl = vi.fn(async () => chat({ choice: "abstain", confidence: 0.99, probabilities: { ...CANARY_PROBABILITIES, two: 0.005, abstain: 0.97 } }));
    await expect(probeDecisionModel(config, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({ ok: false, reason: "uncalibrated" });
  });

  it("maps a dead endpoint to unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); });
    await expect(probeDecisionModel(config, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("refuses to send a configured key over an http: endpoint", async () => {
    const fetchImpl = vi.fn();
    await expect(probeDecisionModel({ ...config, apiKey: "sk-cleartext" }, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      ok: false,
      reason: "uncalibrated",
      detail: expect.stringContaining("https"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never follows a redirect: the decision POST targets the configured URL only", async () => {
    const inits: Array<{ redirect?: string }> = [];
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      inits.push({ redirect: init?.redirect });
      return chat({ choice: "two", confidence: 0.96, probabilities: CANARY_PROBABILITIES });
    });
    await expect(probeDecisionModel(config, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({ ok: true });
    expect(inits).toHaveLength(2);
    expect(inits.every((init) => init.redirect === "error")).toBe(true);
  });
});

describe("createCalibrationGate", () => {
  it("caches a passing verdict per connection and re-probes on change", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, check: "calibration" as const, model: "m", confidence: 0.9, deterministic: true as const }));
    const gate = createCalibrationGate(probe);
    const config = { provider: "typesafe" as const, model: "m", apiKey: "k" };
    expect(gate.cached(config)).toBe(false);
    await gate.probe(config);
    expect(gate.cached(config)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    // a second probe inside the cache window does not hit the server again
    await gate.probe(config);
    expect(probe).toHaveBeenCalledTimes(1);
    // a changed key is a different connection: fresh probe, fresh verdict
    const rotated = { ...config, apiKey: "k2" };
    expect(gate.cached(rotated)).toBe(false);
    await gate.probe(rotated);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(gate.cached(rotated)).toBe(true);
  });

  it("backs off a failing connection instead of hammering it", async () => {
    const probe = vi.fn(async () => ({ ok: false as const, reason: "unreachable" as const }));
    const gate = createCalibrationGate(probe);
    const config = { provider: "typesafe" as const, model: "m", apiKey: "k" };
    expect(await gate.calibrated(config)).toBe(false);
    expect(await gate.calibrated(config)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(gate.cached(config)).toBe(false);
  });
});
