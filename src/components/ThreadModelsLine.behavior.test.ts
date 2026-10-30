// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, Task } from "@/state/store";

type Settled = (result: { busy: number }) => void;
const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));

const { ThreadModelsLine } = await import("./ThreadModelsLine");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const opus = { instanceId: "claude", model: "claude-opus-5" };
const codex = { instanceId: "codex", model: "gpt-5-codex" };
const task = (threadId: string, overrides: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 1, ...overrides });
const ada = (own: number): Bot => ({
  id: "ada", threadId: "first", name: "Ada", title: "", description: "", notifications: true, color: "green", unread: false,
  messages: [], modelSelection: opus,
  tasks: [
    task("first", { modelSelection: opus, followsBotModel: true }),
    ...Array.from({ length: own }, (_, index) => task(`own-${index}`, { modelSelection: codex, followsBotModel: false })),
  ],
});

beforeEach(() => {
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function clickAndSettle(bot: Bot, result: { busy: number }) {
  await act(async () => root.render(createElement(ThreadModelsLine, { bot })));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-switch-them-too]")!.click());
  const action = fixture.dispatch.mock.lastCall![0] as { type: string; botId: string; onSettled: Settled };
  await act(async () => action.onSettled(result));
  return action;
}
const note = () => host.querySelector("[data-busy-threads]")?.textContent ?? null;

describe("ThreadModelsLine's Switch them too", () => {
  it("moves every thread onto the bot's model", async () => {
    const action = await clickAndSettle(ada(2), { busy: 0 });
    expect(action).toMatchObject({ type: "followBotModel", botId: "ada" });
    expect(note()).toBeNull();
  });

  it("says when a busy thread kept its own model, instead of looking like nothing happened", async () => {
    await clickAndSettle(ada(1), { busy: 1 });
    expect(note()).toBe("1 thread is busy, so it kept its own model. Try again when it's done.");
  });

  it("counts several busy threads, and clears the note once a retry gets through", async () => {
    await clickAndSettle(ada(3), { busy: 2 });
    expect(note()).toBe("2 threads are busy, so they kept their own model. Try again when they're done.");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-switch-them-too]")!.click());
    await act(async () => (fixture.dispatch.mock.lastCall![0] as { onSettled: Settled }).onSettled({ busy: 0 }));
    expect(note()).toBeNull();
  });

  it("ignores a slower earlier click that settles after the retry", async () => {
    await act(async () => root.render(createElement(ThreadModelsLine, { bot: ada(2) })));
    const click = async () => {
      await act(async () => host.querySelector<HTMLButtonElement>("[data-switch-them-too]")!.click());
      return fixture.dispatch.mock.lastCall![0] as { onSettled: Settled };
    };
    const first = await click();
    const retry = await click();
    await act(async () => retry.onSettled({ busy: 0 }));
    await act(async () => first.onSettled({ busy: 1 }));
    expect(note()).toBeNull();
  });
});
