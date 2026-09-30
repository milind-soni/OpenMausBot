import { describe, expect, it } from "vitest";
import { scenarioSchema } from "../types.ts";
import { runScenario } from "./run-scenario.ts";

// Pins the gatesDir/OMB_DATA_DIR contract end to end. The server hot-loads
// user skills from <OMB_DATA_DIR>/skills (index.ts), and installSkill writes
// to <parent-of-eval-gates>/skills, so eval-gates must sit under the data
// dir. Before the fix this world passed <fixtureHome>/eval-gates while
// OMB_DATA_DIR was <fixtureHome>/data: the skill installed fine and the run
// stayed green, but the block never reached the system prompt.
describe("localVm world installSkill", () => {
  it("lands user skills where the server hot-loads them", async () => {
    const scenario = scenarioSchema.parse({
      id: "local-vm-skill-install",
      title: "installSkill reaches the localVm server prompt",
      behavior: "A skill installed before the send rides the system prompt as an openmaus-skill block.",
      world: "localVm",
      gates: [],
      bots: [{ key: "worker", name: "Skill holder", turns: [{ reply: "Skill instructions followed." }] }],
      steps: [
        {
          kind: "installSkill",
          skill: {
            id: "local-vm-pin",
            name: "Local VM Pin",
            version: "0.1.0",
            description: "Pin the user-skill install path.",
            defaultEnabled: true,
            triggerTerms: ["pincheck"],
            requiredCapabilities: [],
            skillMd: "---\nname: local-vm-pin\ndescription: Pin the user-skill install path.\n---\n\n# Local VM Pin\n\nWhen the user says pincheck, reply exactly: Skill instructions followed.\n",
          },
        },
        { kind: "send", bot: "worker", text: "pincheck please." },
        { kind: "waitForTurns", bot: "worker", count: 1, timeoutMs: 20_000 },
      ],
      assertions: [
        { kind: "systemPromptIncludes", bot: "worker", turn: 0, includes: '<openmaus-skill id="local-vm-pin"' },
      ],
    });
    const result = await runScenario(scenario);
    expect(result.error).toBeUndefined();
    expect(result.pass).toBe(true);
  }, 60_000);
});
