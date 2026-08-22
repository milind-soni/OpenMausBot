import { describe, expect, it } from "vitest";

import { buildOpenMausWorkRequest, UNATTENDED_FORBIDDEN_ACTIONS } from "./unattended-work";

describe("buildOpenMausWorkRequest", () => {
  it("builds the deterministic guarded work envelope", () => {
    const request = buildOpenMausWorkRequest({
      repository: " lightcloud00/example ",
      issue: "1302",
      repoPath: " /tmp/example-worktree ",
      baselineSha: "A".repeat(40),
      taskBranch: " codex/example ",
      allowedPaths: "src/\n\ntests/\n",
      acceptanceTests: "pnpm typecheck\npnpm test\n",
      tokenBudget: "12000",
      maxRuntimeSeconds: "3600",
    });

    expect(request).toMatchObject({
      schema: "aos.work-request.v1",
      ingress: "openmausbot",
      idempotency_key: "work:lightcloud00/example:1302",
      repository: "lightcloud00/example",
      issue: 1302,
      card: {
        github_issue: "lightcloud00/example#1302",
        baseline_sha: "a".repeat(40),
        acceptance_tests: ["pnpm typecheck", "pnpm test"],
        mutation_boundary: { allowed: ["src/", "tests/"], forbidden: UNATTENDED_FORBIDDEN_ACTIONS },
      },
    });
  });
});
