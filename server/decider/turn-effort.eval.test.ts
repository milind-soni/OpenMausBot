import { describe, expect, it } from "vitest";
import { createDecider } from "./index.ts";
import { decideTurnEffort } from "./turn-effort.ts";

const live = process.env.OMB_TURN_EFFORT_LIVE_EVAL === "1";

describe.skipIf(!live)("turn effort live evaluation", () => {
  it("recognizes work requests across languages", { timeout: 60_000 }, async () => {
    const key = process.env.OMB_JEV_API_KEY ?? "";
    expect(key, "Set OMB_JEV_API_KEY to run this paid evaluation").not.toBe("");
    const decider = createDecider({ config: () => ({ decider: { enabled: true, key, jobs: { turnEffort: true } } }) });
    for (const text of ["Find and fix an intermittent login failure involving session cookies and a race condition", "Encontre e corrija uma falha intermitente no login envolvendo cookies de sessão e uma condição de corrida", "Найди и исправь периодическую ошибку входа, связанную с cookie сессии и состоянием гонки"]) {
      const effort = await decideTurnEffort(decider, { text, attachments: 0, priorTurnUsedTools: false }, ["low", "medium", "high"]);
      expect(effort, text).toBe("high");
    }
  });
});
