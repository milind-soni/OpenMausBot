import { describe, expect, it } from "vitest";

import { CHAT_TOOL_LIMIT, chatToolBudgetFit } from "./tool-budget.ts";

describe("chatToolBudgetFit", () => {
  it("fits a server that leaves room next to other servers", () => {
    expect(chatToolBudgetFit(0)).toBe("fits");
    expect(chatToolBudgetFit(63)).toBe("fits");
  });

  it("crowds from half of the limit on", () => {
    expect(chatToolBudgetFit(64)).toBe("crowds");
    expect(chatToolBudgetFit(127)).toBe("crowds");
  });

  it("keeps a server that fills the limit whole", () => {
    expect(chatToolBudgetFit(CHAT_TOOL_LIMIT)).toBe("crowds");
  });

  it("exceeds only past the limit", () => {
    expect(chatToolBudgetFit(CHAT_TOOL_LIMIT + 1)).toBe("exceeds");
    expect(chatToolBudgetFit(200)).toBe("exceeds");
  });

  it("reads a limit the caller learned from the provider", () => {
    expect(chatToolBudgetFit(4, 10)).toBe("fits");
    expect(chatToolBudgetFit(5, 10)).toBe("crowds");
    expect(chatToolBudgetFit(10, 10)).toBe("crowds");
    expect(chatToolBudgetFit(11, 10)).toBe("exceeds");
  });
});
