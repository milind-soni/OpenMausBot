import { describe, expect, it } from "vitest";
import { scenarioSchema } from "../types.ts";
import { runScenario } from "./run-scenario.ts";

// installSkill writes to <parent-of-eval-gates>/skills and the server hot-loads
// <OMB_DATA_DIR>/skills, so eval-gates must sit under the data dir.
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
