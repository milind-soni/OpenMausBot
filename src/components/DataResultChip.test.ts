// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { groupTranscript, isStatusActivity } from "@/lib/activity-runs";
import { activityPreview, failedTurnCause } from "@/lib/failed-turn";
import { roomActivityVisible } from "@/lib/room-activity";

const dispatch = vi.fn();
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [{ id: "bot" }] }, dispatch }) }));
import { DataResultChip } from "./DataResultChip";

// As the server stores it: the tool that ran, with the card's title only in dataResult.
const message: Message = { id: "receipt", at: 1, role: "bot", kind: "activity", tool: { name: "data_show", ok: true },
  dataResult: { botId: "bot", cardId: "c_1", title: "Revenue", kind: "chart" } };

describe("Data result receipt", () => {
  it("expands only the recorded SQL without opening the viewer", () => {
    dispatch.mockClear();
    const container = document.createElement("div");
    const root = createRoot(container);
    const sql = "SELECT region, sum(revenue) AS revenue FROM orders GROUP BY region";
    try {
      flushSync(() => root.render(createElement(DataResultChip, { message: { ...message, dataResult: { ...message.dataResult!, sql } } })));
      const disclosure = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector("pre")).toBeNull();
      flushSync(() => disclosure.click());
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      expect(container.querySelector("pre code")!.textContent).toBe(sql);
      expect(container.querySelector("pre")!.parentElement!.id).toBe(disclosure.getAttribute("aria-controls"));
      expect(dispatch).not.toHaveBeenCalled();
      container.querySelector<HTMLButtonElement>("button:not([aria-expanded])")!.click();
      expect(dispatch).toHaveBeenCalledWith({ type: "openDataResult", botId: "bot", cardId: "c_1" });
      flushSync(() => disclosure.click());
      expect(container.querySelector("pre")).toBeNull();
    } finally { root.unmount(); }
  });

  it("opens the exact result and renders no duplicate chart", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      flushSync(() => root.render(createElement(DataResultChip, { message })));
      expect(container.textContent).toContain("Revenue");
      expect(container.textContent).toContain("Open in Data");
      expect(container.querySelector("button[aria-expanded]")).toBeNull();
      container.querySelector("button")!.click();
      expect(dispatch).toHaveBeenCalledWith({ type: "openDataResult", botId: "bot", cardId: "c_1" });
      expect(container.querySelector("canvas,table,iframe")).toBeNull();
      flushSync(() => root.render(createElement(DataResultChip, { message: { ...message, dataResult: { ...message.dataResult!, botId: "deleted" } } })));
      expect(container.querySelector("button")!.disabled).toBe(true);
      vi.stubGlobal("ogb", { remoteClient: { active: true } });
      flushSync(() => root.render(createElement(DataResultChip, { message })));
      expect(container.querySelector("button")!.disabled).toBe(true);
      expect(container.querySelector("button")!.title).toContain("companion");
    } finally { root.unmount(); vi.unstubAllGlobals(); }
  });

  it("is never read as a status row, a failed turn or a bare tool name, whatever the result is called", () => {
    const titled = (title: string): Message => ({ ...message, dataResult: { ...message.dataResult!, title } });
    for (const title of ["notice: revenue by region", "error: rows with no region", "stopped: deliveries", "recovery: Q3"]) {
      const receipt = titled(title);
      expect(isStatusActivity(receipt)).toBe(false);
      expect(failedTurnCause(receipt.tool!.name)).toBeNull();
      expect(activityPreview(receipt.tool!, undefined, receipt.dataResult)).toBe(title);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        flushSync(() => root.render(createElement(DataResultChip, { message: receipt })));
        expect(container.querySelector("[data-data-result='c_1']")!.textContent).toContain(title);
        expect(container.querySelector("[role=status]")).toBeNull();
      } finally { root.unmount(); }
    }
    expect(activityPreview({ name: "Read file", ok: true }, undefined)).toBe("Read file");
  });

  it("stays visible with tool calls hidden and outside folded tool runs", () => {
    expect(roomActivityVisible(message, false)).toBe(true);
    const ordinary = { ...message, dataResult: undefined };
    const grouped = groupTranscript([{ ...ordinary, id: "a" }, { ...ordinary, id: "b" }, message]);
    expect(grouped.map((item) => item.kind)).toEqual(["run", "message"]);
  });
});
