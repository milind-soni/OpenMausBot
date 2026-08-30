import { describe, expect, it } from "vitest";
import {
  beginBrowserPanelOperation,
  browserPanelOperationPending,
} from "./browser-panel-operation";

describe("browser panel operation handoff", () => {
  it("keeps a bot locked until every overlapping operation finishes", () => {
    const finishFirst = beginBrowserPanelOperation("bot-a");
    const finishSecond = beginBrowserPanelOperation("bot-a");

    expect(browserPanelOperationPending("bot-a")).toBe(true);
    expect(browserPanelOperationPending("bot-b")).toBe(false);
    finishFirst();
    expect(browserPanelOperationPending("bot-a")).toBe(true);
    finishSecond();
    expect(browserPanelOperationPending("bot-a")).toBe(false);
  });

  it("makes operation cleanup idempotent", () => {
    const finish = beginBrowserPanelOperation("bot-a");
    finish();
    finish();
    expect(browserPanelOperationPending("bot-a")).toBe(false);
  });
});
