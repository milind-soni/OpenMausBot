import { describe, expect, it } from "vitest";

import { changedRoutineRefusalText } from "../cloud-lending.ts";
import { addServerLinePacks } from "../server-lines.ts";
import type { RoutineRunStatus } from "../../shared/routines.ts";
import ptBr from "../../src/locales/pt-br.json" with { type: "json" };
import { createRefusedLending } from "./refused-lending.ts";

function fixture(over: { device?: "PC" | "Mac" | "computer" | null; status?: (id: string) => RoutineRunStatus | undefined; language?: string } = {}) {
  let current: { id: string } | undefined = { id: "run_1" };
  const refused = createRefusedLending({
    runOf: () => current, statusOf: (id) => over.status?.(id) ?? "running",
    lentDevice: () => (over.device === undefined ? "PC" : over.device), language: () => over.language,
  });
  return { refused, now: (run: { id: string } | undefined) => { current = run; } };
}

describe("a routine's run refused the lent computer (server/host/refused-lending.ts)", () => {
  it("ends saying, once, the very sentence the bot was given, with the computer the person lends", () => {
    const { refused } = fixture();
    refused.refused("t", "run_1", "Morning plan");
    expect(refused.take("t")).toBe(changedRoutineRefusalText("Morning plan", "PC"));
    expect(refused.take("t")).toBeNull();
    const mac = fixture({ device: "Mac" });
    mac.refused.refused("t", "run_1", "Morning plan");
    expect(mac.refused.take("t")).toBe(changedRoutineRefusalText("Morning plan", "Mac"));
  });

  it("stays quiet for a run never refused, and when nothing is lent, since then the refusal cost it nothing", () => {
    expect(fixture().refused.take("t")).toBeNull();
    const none = fixture({ device: null });
    none.refused.refused("t", "run_1", "Morning plan");
    expect(none.refused.take("t")).toBeNull();
  });

  it("is never another run's: a refusal for a run that is no longer this conversation's, or a later run here, says nothing", () => {
    const late = fixture();
    late.refused.refused("t", "run_0", "Morning plan");
    expect(late.refused.take("t")).toBeNull();
    const next = fixture();
    next.refused.refused("t", "run_1", "Morning plan");
    next.now({ id: "run_2" });
    expect(next.refused.take("t")).toBeNull();
  });

  it("forgets the refusal of a run that ended without taking it", () => {
    const status = new Map<string, RoutineRunStatus>([["run_1", "failed"]]);
    const { refused, now } = fixture({ status: (id) => status.get(id) });
    refused.refused("t", "run_1", "Morning plan");
    now({ id: "run_2" });
    refused.refused("t", "run_2", "Evening plan");
    now({ id: "run_1" });
    expect(refused.take("t")).toBeNull();
    now({ id: "run_2" });
    expect(refused.take("t")).toBe(changedRoutineRefusalText("Evening plan", "PC"));
  });

  it("reads in the language of the chat it reports to", () => {
    addServerLinePacks({ "pt-br": ptBr });
    const { refused } = fixture({ language: "pt-br" });
    refused.refused("t", "run_1", "Plano da manhã");
    expect(refused.take("t")).toBe("\"Plano da manhã\" não pode usar seu PC porque não está confirmada como sua: ela foi alterada ou criada pela última vez fora das suas próprias conversas. Abra a rotina e salve para que ela volte a ser sua.");
  });
});
