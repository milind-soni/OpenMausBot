// "Switch them too" beside a bot's model: one line and one button, only
// while some of the bot's threads run on a model of their own.
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, Task } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: (() => {}) as (...args: unknown[]) => void }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));

const { ThreadModelsLine } = await import("./ThreadModelsLine");

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

const opus = { instanceId: "claude", model: "claude-opus-5" };
const codex = { instanceId: "codex", model: "gpt-5-codex" };
const task = (threadId: string, overrides: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 1, ...overrides });
const ada = (tasks: Task[]): Bot => ({
  id: "ada", threadId: "first", name: "Ada", title: "", description: "", notifications: true, color: "green", unread: false,
  messages: [], modelSelection: opus, tasks,
});
const html = (bot: Bot) => renderToStaticMarkup(createElement(ThreadModelsLine, { bot }));

beforeEach(() => {
  fixture.dispatch = vi.fn();
});

describe("ThreadModelsLine", () => {
  it("shows nothing while every thread follows the bot, or a thread's own model is the bot's", () => {
    expect(html(ada([task("first", { modelSelection: opus, followsBotModel: true }), task("same", { modelSelection: opus, followsBotModel: false })]))).toBe("");
    expect(html(ada([]))).toBe("");
  });

  it("shows nothing for a server too old to say whether a thread follows", () => {
    expect(html(ada([task("old", { modelSelection: codex })]))).toBe("");
  });

  it("counts the threads on a model of their own, and Switch them too moves them all onto the bot's", () => {
    const bot = ada([
      task("first", { modelSelection: opus, followsBotModel: true }),
      task("one", { modelSelection: codex, followsBotModel: false }),
      task("two", { modelSelection: { ...opus, effort: "high" }, followsBotModel: false }),
    ]);
    expect(html(bot)).toContain("2 threads use their own model.");
    expect(html(bot)).toContain("Switch them too");
    const button = nodes(ThreadModelsLine({ bot })).find((node) => node.props["data-switch-them-too"] !== undefined)!;
    (button.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "followBotModel", botId: "ada" });
  });

  it("says one thread in the singular", () => {
    const line = html(ada([task("one", { modelSelection: codex, followsBotModel: false })]));
    expect(line).toContain("1 thread uses its own model.");
    expect(line).toContain("Switch it too");
  });
});
