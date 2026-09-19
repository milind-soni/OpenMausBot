// Full access survives the per-turn gate only when the engine implements
// the level (supportsApprovalMode). Issue #1533: the openai-compat kind —
// DeepSeek, GLM, OpenRouter — was missing from that whitelist, so a granted
// Full was silently downgraded to Ask and every tool call came back as an
// Allow/Deny card. These tests pin the pass-through and the downgrade that
// still guards engines without the mapping.
import { describe, expect, it, vi } from "vitest";

vi.mock("./runtime.ts", () => ({
  registry: { cliTarget: vi.fn() },
  store: {},
  cfg: {},
}));

import { registry } from "./runtime.ts";
import { createBotViews, type BotViewsDeps } from "./bot-views.ts";
import type { BotRecord } from "./store.ts";

// approvalModeForTurn reads only the registry; the host wiring sharing its
// factory must never be reached from this path, so the stubs throw.
const unreachable = (): never => {
  throw new Error("approvalModeForTurn must not reach its host wiring");
};
const views = createBotViews({
  lateBound: { connectorThread: unreachable, roomHandoffs: unreachable, routines: unreachable, webhooks: unreachable },
  helpers: { turnInstance: unreachable, inheritedTeamComputer: unreachable, teamComputerPrompt: unreachable },
} as BotViewsDeps);

const fullAccessBot = (instanceId: string): BotRecord => ({
  modelSelection: { instanceId, model: "test-model" },
  approvalMode: "full",
  autoApprove: false,
} as BotRecord);

describe("approvalModeForTurn", () => {
  it("keeps a granted Full for an openai-compat engine instead of downgrading to Ask", () => {
    vi.mocked(registry.cliTarget).mockReturnValue({ driverKind: "openai-compat", cli: null });
    expect(views.approvalModeForTurn(fullAccessBot("omb-openai-compat"))).toBe("full");
  });

  it("still downgrades Full to Ask for an engine without a Full mapping", () => {
    vi.mocked(registry.cliTarget).mockReturnValue({ driverKind: "not-a-real-driver", cli: null });
    expect(views.approvalModeForTurn(fullAccessBot("omb-unmapped"))).toBe("ask");
  });
});
