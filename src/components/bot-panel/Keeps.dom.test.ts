// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ skills: [] as unknown[], skillBurger: true }));
vi.mock("./use-memory-doc", () => ({ useMemoryDoc: () => ({ docs: null, error: false }) }));
vi.mock("../bot-settings/SkillsSection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../bot-settings/SkillsSection")>(),
  useManagedSkills: () => ({ skills: fixture.skills, loading: false }),
}));
vi.mock("@/lib/use-feature", () => ({ useFeature: () => fixture.skillBurger }));

const { BotKeeps } = await import("./Keeps");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "scout", threadId: "t1", name: "Scout", messages: [], modelSelection: { instanceId: "x", model: "x" } } as unknown as Bot;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.skills = [];
  fixture.skillBurger = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (onOpen: (page: string) => void = () => {}) => {
  await act(async () => root.render(createElement(BotKeeps, { bot, onOpen })));
};

it("lists what it remembers, its skills and its folder, and each opens its page", async () => {
  const opened: string[] = [];
  await render((page) => opened.push(page));
  const rows = [...host.querySelectorAll<HTMLButtonElement>("[data-panel-page]")];
  expect(rows.map((row) => row.dataset.panelPage)).toEqual(["memory", "skills", "folder"]);
  for (const row of rows) await act(async () => row.click());
  expect(opened).toEqual(["memory", "skills", "folder"]);
});

it("counts a saved Skill Burger among the bot's skills only while Skill Burger is on", async () => {
  fixture.skills = [
    { name: "weekly-report", source: "skill-burger:scout", enabled: true },
    { name: "tidy-notes", source: "conversation", enabled: true },
  ];
  await render();
  expect(host.querySelector('[data-panel-page="skills"]')!.textContent).toContain("2");
  fixture.skillBurger = false;
  await render();
  expect(host.querySelector('[data-panel-page="skills"]')!.textContent).toContain("1");
  expect(host.querySelector('[data-panel-page="skills"]')!.textContent).not.toContain("2");
});
