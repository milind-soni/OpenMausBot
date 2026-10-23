import { afterEach, expect, it, vi } from "vitest";
import { reviewApproval } from "../approval-review.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => vi.unstubAllGlobals());

it.each(["gpt-4o", "o3", "local-model"])("does not assume reviewer effort support for %s on a generic endpoint", async model => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) return new Response("", { status: 404 });
    bodies.push(JSON.parse(String(init?.body)));
    const frame = { choices: [{ index: 0, delta: { content: JSON.stringify({ decision: "allow", reason: "Synthetic read authorized." }) }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }));
  const provider = await OpenAICompatDriver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "http://127.0.0.1:9/v1", apiKeyEnv: "FIXTURE_KEY", model }), environment: { FIXTURE_KEY: "synthetic" } });
  const input = { action: { tool: "read_status", arguments: {} }, session: { instanceId: "fixture", model },
    messages: [{ id: "person", at: 1, role: "user" as const, kind: "text" as const, text: "Read the synthetic status." }],
    getProvider: () => provider, isCurrent: () => true };
  try {
    expect(provider.adapter.capabilities.approvalReviewEffortLevels).toBeUndefined();
    expect(await reviewApproval({ ...input, settings: {} })).toMatchObject({ decision: "allow" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    for (const effort of ["none", "high", "max"] as const) {
      expect(await reviewApproval({ ...input, settings: { model: { ...input.session, effort } } }))
        .toMatchObject({ decision: "ask", reason: expect.stringContaining("effort is not supported") });
    }
    expect(bodies).toHaveLength(1);
  } finally { await provider.dispose(); }
});
