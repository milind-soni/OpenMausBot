import { describe, expect, it } from "vitest";

import { ONE_PASSWORD_REFUSED, OnePasswordUnavailableError, onePasswordFailure, onePasswordProblem } from "../onepassword.ts";
import { teamVaultReport } from "./team-vault-report.ts";

const BOTS = [
  { id: "b1", name: "Ledger" },
  { id: "b2", name: "Scout" },
  { id: "b3", name: "Hidden", hidden: true },
  { id: "b4", name: "Ada's MausBot", defaultBot: { person: "p_ada" } },
];

describe("the team's Vault in the Admin's report", () => {
  it("names each secret, when it was added and the team bots that may use it, never a member's own MausBot", () => {
    const report = teamVaultReport({
      secrets: [{ name: "Stripe key", createdAt: Date.UTC(2026, 10, 1), bots: "all" }, { name: "Deploy key", createdAt: Date.UTC(2026, 10, 2), bots: ["b2", "b4", "gone"] }],
      bots: BOTS, onePassword: { connected: false },
    });
    expect(report).toEqual({
      secrets: [
        { name: "Stripe key", addedAt: "2026-11-01T00:00:00.000Z", usedBy: ["Ledger", "Scout"] },
        { name: "Deploy key", addedAt: "2026-11-02T00:00:00.000Z", usedBy: ["Scout"] },
      ],
      providers: [{ kind: "1password", connected: false, label: "" }],
    });
  });

  it("says 1Password's vaults and why it is not working as a fixed class, never its words or token", () => {
    const report = teamVaultReport({ secrets: [], bots: BOTS, onePassword: { connected: true, items: 2, error: ONE_PASSWORD_REFUSED,
      vaults: [{ id: "v1", title: "Team keys", items: 2, bots: "all" }, { id: "v2", title: "Finance", items: 0, bots: ["b1"] }] } });
    expect(report.providers).toEqual([{ kind: "1password", connected: true, label: "Team keys, Finance", lastError: "refused" }]);
    expect(JSON.stringify(report)).not.toContain(ONE_PASSWORD_REFUSED);
  });

  it("classes every 1Password problem", () => {
    const failure = (error: unknown) => onePasswordFailure(onePasswordProblem(error));
    expect(failure(new Error("error authenticating: invalid service account token"))).toBe("refused");
    expect(failure(new Error("service account token had invalid format"))).toBe("refused");
    expect(failure(Object.assign(new Error("slow down"), { name: "RateLimitExceededError" }))).toBe("rate-limited");
    expect(failure(new Error("getaddrinfo ENOTFOUND my.1password.com"))).toBe("cant-connect");
    expect(failure(new OnePasswordUnavailableError())).toBe("unavailable");
    expect(failure(new SyntaxError("Unexpected token"))).toBe("unreadable");
  });
});
