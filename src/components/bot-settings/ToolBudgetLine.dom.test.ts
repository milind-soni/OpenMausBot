// @vitest-environment happy-dom
// The tool budget line on a bot's MCP servers card, in a real DOM, against the harness's answer for the bot.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { ToolBudget } from "../../../shared/tool-budget";

const fixture = vi.hoisted(() => ({ budget: null as ToolBudget | null, asked: [] as string[] }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: (path: string) => { fixture.asked.push(path); return Promise.resolve({ budget: fixture.budget }); } };
});

const { ToolBudgetLine } = await import("./ToolBudgetLine");

let host: HTMLDivElement;
let root: Root;
const render = (busy = false) => flushSync(() => root.render(createElement(ToolBudgetLine, { botId: "scout", busy })));
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  setLocale("en");
  fixture.budget = null;
  fixture.asked = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("a bot's tool budget", () => {
  it("says how many of its AI's tools the last turn listed, and which servers it found through tool search", async () => {
    fixture.budget = { limit: 128, listed: 127, servers: [
      { name: "basicmemory", tools: 12, direct: true }, { name: "sogni", tools: 40, direct: false }, { name: "context7", tools: 2, direct: false },
    ] };
    render();
    await settle();
    expect(fixture.asked).toEqual(["/api/bots/scout/tool-budget"]);
    expect(host.querySelector("[data-tool-budget]")?.firstElementChild?.textContent).toBe("Its last turn listed 127 of the 128 tools its AI takes at once.");
    expect(host.querySelector("[data-tool-budget-searched]")?.textContent).toBe("Found through tool search instead: sogni and context7");
  });

  it("leaves out the search line when every server was listed, and shows nothing before a turn ran", async () => {
    fixture.budget = { limit: 128, listed: 20, servers: [{ name: "basicmemory", tools: 12, direct: true }] };
    render();
    await settle();
    expect(host.querySelector("[data-tool-budget]")).not.toBeNull();
    expect(host.querySelector("[data-tool-budget-searched]")).toBeNull();
    fixture.budget = null;
    flushSync(() => root.unmount());
    root = createRoot(host);
    render();
    await settle();
    expect(host.innerHTML).toBe("");
  });

  it("reads the budget again when the bot's turn ends, not while it works", async () => {
    render();
    await settle();
    render(true);
    await settle();
    expect(fixture.asked).toHaveLength(1);
    render(false);
    await settle();
    expect(fixture.asked).toHaveLength(2);
  });
});
