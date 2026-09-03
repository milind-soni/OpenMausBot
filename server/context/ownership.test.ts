// Every engine must state who owns its model-facing context. Making the
// field required puts the type system on that; what this covers is the
// specific regression behind it — three driver kinds share one runtime, and
// the dispatch site used to name only one of them.
import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import type { AnyProviderDriver } from "../contracts.ts";
import type { ContextOwnership } from "./types.ts";

const OWNERSHIP: readonly ContextOwnership[] = ["vendor-session", "omb-replay", "omb-loop"];

/** The three kinds built on createOpenAIChatRuntime. They speak OpenAI chat
 * completions, so create() opens no process and reaches no network — it
 * just needs a key to consider itself configured. */
const CHAT_RUNTIME_KINDS = ["grok", "openai-compat", "minimax"] as const;

const driverFor = (kind: string): AnyProviderDriver => {
  const driver = BUILT_IN_DRIVERS.find((d) => d.driverKind === kind);
  if (!driver) throw new Error(`no built-in driver registered for kind "${kind}"`);
  return driver;
};

const ownershipOf = async (kind: string): Promise<ContextOwnership> => {
  const driver = driverFor(kind);
  const instance = await driver.create({
    instanceId: `${kind}-test`,
    displayName: undefined,
    environment: {},
    enabled: true,
    config: driver.decodeConfig({ key: "test-key-not-used" }),
  });
  try {
    return instance.adapter.capabilities.contextOwnership;
  } finally {
    await instance.dispose?.();
  }
};

describe("context ownership is declared, not inferred", () => {
  it("registers every kind the chat runtime backs", () => {
    for (const kind of CHAT_RUNTIME_KINDS) {
      expect(() => driverFor(kind), kind).not.toThrow();
    }
  });

  it("declares `omb-replay` for ALL three chat-runtime kinds, not just grok", async () => {
    // The defect this replaces: dispatch tested `driverKind === "grok"`,
    // so openai-compat and minimax were inlined a replay on top of the
    // structured history the runtime already sends — the branch twice.
    for (const kind of CHAT_RUNTIME_KINDS) {
      expect(await ownershipOf(kind), kind).toBe("omb-replay");
    }
  });

  it("never reports a value outside the union", async () => {
    for (const kind of CHAT_RUNTIME_KINDS) {
      expect(OWNERSHIP, kind).toContain(await ownershipOf(kind));
    }
  });
});
