// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ bots: [] as Bot[], dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, bots: fixture.bots }, dispatch: fixture.dispatch }),
  };
});

import { LocalVmBotSelection } from "./LocalVmBotSelection";

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(LocalVmBotSelection)));
const checkbox = (botId: string) => host.querySelector<HTMLInputElement>(`[data-local-vm-bot="${botId}"]`)!;

beforeEach(() => {
  fixture.bots = [
    { id: "research", name: "Research", computer: "cloud" } as Bot,
    { id: "writer", name: "Writer", computer: "local" } as Bot,
  ];
  fixture.dispatch.mockImplementation((action: { type: string; botId: string; patch: Partial<Bot> }) => {
    if (action.type === "updateBot") {
      fixture.bots = fixture.bots.map((bot) => bot.id === action.botId ? { ...bot, ...action.patch } : bot);
    }
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  fixture.bots = [];
  fixture.dispatch.mockReset();
});

describe("Local VM bot selection interaction", () => {
  it("sets only the checked bot to Local VM, and returns it to Auto when unchecked", () => {
    render();
    flushSync(() => checkbox("research").click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "updateBot",
      botId: "research",
      patch: { computer: "vm" },
    });
    render();
    expect(checkbox("research").checked).toBe(true);
    expect(fixture.bots.find((bot) => bot.id === "writer")?.computer).toBe("local");

    flushSync(() => checkbox("research").click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "updateBot",
      botId: "research",
      patch: { computer: null },
    });
    render();
    expect(checkbox("research").checked).toBe(false);
    expect(fixture.bots.find((bot) => bot.id === "research")?.computer).toBeNull();
    expect(fixture.bots.find((bot) => bot.id === "writer")?.computer).toBe("local");
  });
});
