import { describe, expect, it, vi } from "vitest";
import { suggestTeamTaskOwner } from "./team-route-client.ts";

const args = {
  task_type: "engineering",
  eligible_owners: [
    { id: "bot-engineer", role: "engineering" },
    { id: "bot-qa", role: "qa_audit" },
  ],
};

function config(fetchImpl: typeof fetch, bots = [
  { id: "bot-engineer", name: "Engineer" },
  { id: "bot-qa", name: "QA" },
]) {
  return {
    endpoint: "https://control-plane.example/v1/team-route/suggest",
    token: "scoped-fixture-token",
    botId: "chief",
    harness: { api: vi.fn(async () => ({ bots })) },
    fetchImpl,
  };
}

describe("OpenMausBot Jev team-route client", () => {
  it("sends only the bounded category and reachable candidate ids and roles", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer scoped-fixture-token");
      expect(JSON.parse(String(init?.body))).toEqual({ task_type: "engineering", eligible_owners: args.eligible_owners });
      return Response.json({
        suggested_owner_id: "bot-engineer",
        confidence: 0.84,
        human_review_required: true,
        input_state_ref: "state-ref",
      });
    });
    const result = await suggestTeamTaskOwner(args, config(fetchImpl));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toMatchObject({
      suggested_owner_id: "bot-engineer",
      suggested_owner_name: "Engineer",
      confidence: 0.84,
      human_review_required: true,
    });
    expect(result.text).not.toContain("task text");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an id that is no longer in the current reachable roster before contacting Jev", async () => {
    const fetchImpl = vi.fn();
    const options = config(fetchImpl, [{ id: "bot-engineer", name: "Engineer" }]);
    const result = await suggestTeamTaskOwner(args, options);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no Jev request was sent/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a reachable UUID whose first character is a digit", async () => {
    const id = "0abc1234-5678-4abc-8def-123456789012";
    const fetchImpl = vi.fn(async () => Response.json({
      suggested_owner_id: id,
      confidence: 0.84,
      human_review_required: true,
    }));
    const result = await suggestTeamTaskOwner({
      task_type: "engineering",
      eligible_owners: [{ id, role: "engineering" }],
    }, config(fetchImpl, [{ id, name: "Engineer" }]));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text).suggested_owner_id).toBe(id);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces Retry-After from 429 and never retries automatically", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: "jev_rate_limited" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "240" },
    }));
    const result = await suggestTeamTaskOwner(args, config(fetchImpl));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Retry-After: 240");
    expect(result.text).toMatch(/do not retry automatically/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when 429 has no Retry-After", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429 }));
    const result = await suggestTeamTaskOwner(args, config(fetchImpl));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("service supplied no Retry-After");
    expect(result.text).toMatch(/do not retry automatically/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed inputs, wrong endpoints and out-of-set Jev answers", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      suggested_owner_id: "not-a-candidate",
      confidence: 0.99,
      human_review_required: true,
    }));
    const options = config(fetchImpl);
    const badArgs = await suggestTeamTaskOwner({ ...args, task_text: "private" }, options);
    expect(badArgs.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    const reservedOwner = await suggestTeamTaskOwner({
      task_type: "engineering",
      eligible_owners: [{ id: "no_suitable_owner", role: "engineering" }],
    }, options);
    expect(reservedOwner.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    const badEndpoint = await suggestTeamTaskOwner(args, { ...options, endpoint: "http://control-plane.example/v1/team-route/suggest" });
    expect(badEndpoint.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    const malformedResult = await suggestTeamTaskOwner(args, options);
    expect(malformedResult.isError).toBe(true);
    expect(malformedResult.text).toMatch(/invalid Jev recommendation/i);
  });
});
