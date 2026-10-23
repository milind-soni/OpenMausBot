import { describe, expect, it } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };
import { failedTurnCause } from "../shared/failed-turn.ts";
import { CHAT_NOTICE, failedNoticeTool, noticeTool, resumedTool } from "./chat-notices.ts";
import { heldMemberLine, isHeldMemberLine } from "./room-holds.ts";

describe("chat notices", () => {
  it("the catalog's chat notices are exactly the ones the server writes", () => {
    const catalog = Object.fromEntries(Object.entries(englishCatalog).filter(([key]) => key.startsWith("chat.notice.")));
    expect(catalog).toEqual(CHAT_NOTICE);
  });

  it("keeps the English name and adds the code beside it", () => {
    expect(noticeTool("chat.notice.cutOffByRestart", { name: "Scout" }, { ok: true })).toEqual({
      ok: true,
      name: "Scout was cut off by a restart; resuming",
      nameCode: "chat.notice.cutOffByRestart",
      nameParams: { name: "Scout" },
    });
    expect(noticeTool("chat.notice.answerPassed", undefined, { ok: true })).toEqual({
      ok: true, name: "Answer passed to the waiting work", nameCode: "chat.notice.answerPassed",
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

  it("words a resumed turn as the English line it replaces, in all its forms", () => {
    const upstream = (asking: boolean, who: string, restart: boolean) =>
      `${asking ? `Resumed with a question from ${who}` : `Resumed with ${who} results`}${restart ? " after a restart" : ""}, reviewing`;
    for (const restart of [false, true]) {
      expect(resumedTool(true, ["Scout", "Ada"], restart).name).toBe(upstream(true, "Scout, Ada", restart));
      expect(resumedTool(false, ["Scout"], restart).name).toBe(upstream(false, "Scout", restart));
      expect(resumedTool(false, [], restart).name).toBe(upstream(false, "delegated work", restart));
    }
    expect(resumedTool(true, ["Scout", "Ada"], true)).toEqual({
      ok: true, name: "Resumed with a question from Scout, Ada after a restart, reviewing",
      nameCode: "chat.notice.resumedQuestionAfterRestart", nameParams: { names: "Scout, Ada" },
    });
    expect(resumedTool(false, [], false)).toEqual({ ok: true, name: "Resumed with delegated work results, reviewing", nameCode: "chat.notice.resumedWork" });
  });

  it("words the held line the sentinel still recognises", () => {
    expect(heldMemberLine("Reviewer")).toBe("Reviewer is held (stopped by you) — @mention it or say resume");
    expect(isHeldMemberLine(noticeTool("chat.notice.roomHeld", { name: "Reviewer" }, { ok: false }).name)).toBe(true);
  });
});
