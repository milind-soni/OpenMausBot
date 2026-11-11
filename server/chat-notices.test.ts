import { describe, expect, it } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };
import { failedTurnCause } from "../shared/failed-turn.ts";
import { CHAT_NOTICE, failedNoticeTool, noticeTool } from "./chat-notices.ts";
import "./server-line-packs.ts";
import { serverLine } from "./server-lines.ts";
import { heldMemberLine, isHeldMemberLine } from "./room-holds.ts";
import { stoppedLine } from "./host/person-first.ts";

describe("chat notices", () => {
  it("the catalog's chat notices are exactly the ones the server writes", () => {
    const clientLabels = new Set(["chat.notice.signIn", "chat.notice.signInHint"]);
    const catalog = Object.fromEntries(Object.entries(englishCatalog).filter(([key]) => key.startsWith("chat.notice.") && !clientLabels.has(key)));
    expect(catalog).toEqual(CHAT_NOTICE);
  });

  it("keeps the English name and adds the code beside it", () => {
    expect(noticeTool("chat.notice.cutOffByRestart", { name: "Scout" }, { ok: true })).toEqual({
      ok: true,
      name: "Scout was cut off by a restart; resuming",
      nameCode: "chat.notice.cutOffByRestart",
      nameParams: { name: "Scout" },
    });
    expect(noticeTool("chat.notice.resumingAfterRestart", undefined, { ok: true })).toEqual({
      ok: true, name: "Resuming after a restart", nameCode: "chat.notice.resumingAfterRestart",
    });
  });

  it("codes only the cause of a failed turn, after its marker", () => {
    const tool = failedNoticeTool("chat.notice.stalled", { minutes: 20 });
    expect(tool).toEqual({
      name: "error: no activity for 20 minutes — the turn was stopped",
      ok: false,
      nameCode: "chat.notice.stalled",
      nameParams: { minutes: 20 },
    });
    expect(failedTurnCause(tool.name)).toBe("no activity for 20 minutes — the turn was stopped");
  });

  it.each([
    ["server.teammates.resumedQuestion", "Resumed with a question from Scout, reviewing", "Retomou o trabalho com uma pergunta de Scout e está revisando"],
    ["server.teammates.resumedQuestionRestart", "Resumed with a question from Scout after a restart, reviewing", "Após uma reinicialização, retomou o trabalho com uma pergunta de Scout e está revisando"],
    ["server.teammates.resumedResults", "Resumed with Scout results, reviewing", "Retomou o trabalho com os resultados de Scout e está revisando"],
    ["server.teammates.resumedResultsRestart", "Resumed with Scout results after a restart, reviewing", "Após uma reinicialização, retomou o trabalho com os resultados de Scout e está revisando"],
    ["server.teammates.backWithResults", "Back with the work it handed on, reviewing", "Voltou com o trabalho que repassou e está revisando"],
    ["server.teammates.backWithResultsRestart", "Back with the work it handed on after a restart, reviewing", "Após uma reinicialização, voltou com o trabalho que repassou e está revisando"],
  ] as const)("words %s on the server, preserving English and Portuguese", (key, english, portuguese) => {
    expect(serverLine(undefined, key, { who: "Scout" })).toBe(english);
    expect(serverLine("pt-br", key, { who: "Scout" })).toBe(portuguese);
  });

  it("words the interrupted step in Portuguese without changing its English duration", () => {
    expect(stoppedLine(45_000)).toBe("Stopped a step that had run for 45 s, to answer you first");
    expect(stoppedLine(120_000)).toBe("Stopped a step that had run for 2 min, to answer you first");
    expect(stoppedLine(45_000, "pt-br")).toBe("Interrompi um passo que já durava 45 s para responder a você primeiro");
    expect(stoppedLine(120_000, "pt-br")).toBe("Interrompi um passo que já durava 2 min para responder a você primeiro");
  });

  it("words a routine hold in Portuguese on the server", () => {
    expect(serverLine("pt-br", "server.routines.held.planCancelled"))
      .toBe("Suas rotinas estão pausadas porque o plano foi cancelado. Para manter uma delas rodando até o fim do plano, ligue-a novamente em “Rotinas”.");
  });

  it("words the held line the sentinel still recognises", () => {
    expect(heldMemberLine("Reviewer")).toBe("Reviewer is held (stopped by you) — @mention it or say resume");
    expect(isHeldMemberLine(heldMemberLine("Reviewer", "pt-br"))).toBe(true);
  });
});
