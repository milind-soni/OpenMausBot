// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DreamReport, UpkeepStatus } from "@/lib/memory";

const calls = vi.hoisted(() => ({ dream: [] as string[], nightly: [] as Array<[string, boolean]>, report: null as unknown }));
vi.mock("@/lib/memory", async (actual) => ({
  ...(await actual<typeof import("@/lib/memory")>()),
  dreamNow: async (botId: string) => { calls.dream.push(botId); return { report: calls.report, overview: {} }; },
  setNightlyDreams: async (botId: string, nightly: boolean) => { calls.nightly.push([botId, nightly]); return { enabled: true, modelSteps: true, dreams: nightly }; },
}));

const { MemoryDreamCard } = await import("./MemoryDreamCard");

let root: Root;
let host: HTMLElement;
const onStatus = vi.fn();
const onDreamt = vi.fn();
const report: DreamReport = {
  at: Date.now() - 60_000,
  conversations: 3,
  learned: [{ text: "The person wants drafts under 100 words", where: "MEMORY.md" }],
  outdated: [{ was: "The person lives in Pune", now: "The person lives in Bangalore" }],
  ideas: ["Send the Monday numbers each week"],
  aboutMe: 1,
};

function render(status: UpkeepStatus | null) {
  flushSync(() => root.render(createElement(MemoryDreamCard, { botId: "b1", botName: "Scout", status, onStatus, onDreamt })));
}
const settle = () => new Promise((done) => setTimeout(done, 0));
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls.dream = [];
  calls.nightly = [];
  calls.report = report;
  onStatus.mockClear();
  onDreamt.mockClear();
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("the dreaming card", () => {
  it("says no dream ran yet, and switches nightly dreams on", async () => {
    render({ enabled: true, modelSteps: true, dreams: false });
    expect(host.textContent).toContain("Once a night, Scout rereads your recent chats");
    expect(host.textContent).toContain("No dream yet.");
    const nightly = host.querySelector<HTMLButtonElement>("[aria-label='Dream every night']")!;
    flushSync(() => nightly.click());
    await settle();
    expect(calls.nightly).toEqual([["b1", true]]);
    expect(onStatus).toHaveBeenCalledWith({ enabled: true, modelSteps: true, dreams: true });
  });

  it("dreams now, hands the report up and asks the section to reload the notes", async () => {
    const status: UpkeepStatus = { enabled: true, modelSteps: true, dreams: true };
    render(status);
    flushSync(() => button("Dream now").click());
    expect(button("Dreaming…").disabled).toBe(true);
    await settle();
    expect(calls.dream).toEqual(["b1"]);
    expect(onStatus).toHaveBeenCalledWith({ ...status, lastDream: report });
    expect(onDreamt).toHaveBeenCalled();
  });

  it("shows what the last dream learned, brought up to date and suggested", () => {
    render({ enabled: true, modelSteps: true, dreams: true, lastDream: report });
    const text = host.textContent ?? "";
    expect(text).toContain("over 3 chats.");
    expect(text).toContain("The person wants drafts under 100 words in MEMORY.md");
    expect(text).toContain("The person lives in Pune → The person lives in Bangalore");
    expect(text).toContain("Send the Monday numbers each week");
    expect(text).toContain("Added 1 fact to About me.");
  });

  it("counts About me facts as a result on their own", () => {
    render({ enabled: true, modelSteps: true, dreams: true, lastDream: { ...report, learned: [], outdated: [], ideas: [], aboutMe: 2 } });
    expect(host.textContent).toContain("Added 2 facts to About me.");
    expect(host.textContent).not.toContain("Nothing new stood out.");
  });

  it("shows the reason when a dream found nothing to read", () => {
    render({ enabled: true, modelSteps: true, dreams: true, lastDream: { ...report, conversations: 1, learned: [], outdated: [], ideas: [], aboutMe: 0, note: "A dream needs at least 2 chats where you wrote since the last one; there is 1." } });
    expect(host.textContent).toContain("over 1 chat.");
    expect(host.textContent).toContain("A dream needs at least 2 chats");
    expect(host.textContent).not.toContain("Nothing new stood out.");
  });
});
