import { describe, expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

const cloudAdmin: RequestAuth = {
  kind: "session",
  session: { id: "admin", scopes: ["admin", "client"], teamRole: "admin" } as never,
  via: "bearer",
  scopes: ["admin", "client"],
};

describe("bot task GitHub access", () => {
  it.each([
    { auth: { kind: "loopback", trust: "service", scopes: [] }, cloudTeam: false },
    { auth: cloudAdmin, cloudTeam: true },
  ])("rejects unauthorized security settings changes", async ({ auth, cloudTeam }) => {
    const setBotTasksGithubToken = vi.fn();
    const route = createConfigRoutes({ cloudTeam, botTasksVault: { setBotTasksGithubToken } } as unknown as ConfigRouteDeps);
    const json = vi.fn();
    for (const botTasks of [
      { githubToken: "fixture-token" }, { repos: ["org/repo"] }, { requireEvidenceForDone: false }, { requireEvidenceForReview: false },
    ]) {
      await route({
        req: {}, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method: "PATCH", auth,
        json, readBody: async () => ({ botTasks }),
      } as unknown as Parameters<typeof route>[0]);
    }

    expect(json.mock.calls).toEqual(Array(4).fill([expect.anything(), 403, { error: "Only the owner can change GitHub access for bot tasks." }]));
    expect(setBotTasksGithubToken).not.toHaveBeenCalled();
  });
});
