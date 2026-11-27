// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot, Task } from "@/state/store";

const drawn = vi.hoisted(() => ({ avatars: 0 }));
vi.mock("@/lib/use-feature", () => ({ useFeature: (name: string) => name === "threadTabs" }));
vi.mock("@/state/store-select", () => ({ useStoreDispatch: () => vi.fn(), useStoreSelector: () => undefined }));
vi.mock("./Avatar", () => ({ BotAvatar: () => { drawn.avatars++; return null; } }));

import { HeaderThreadTabs } from "./HeaderThreadTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (threadId: string, title: string, at: number, extra: Partial<Task> = {}): Task => ({ threadId, title, createdAt: at, lastThreadOrderAt: at, ...extra });
const tasks = () => Array.from({ length: 60 }, (_, i) => task(`t${i}`, `Thread ${i}`, 100 - i, i === 0 ? { busy: true } : {}));
const kiwi = (extra: Partial<Bot> = {}): Bot =>
  ({ id: "kiwi", name: "Kiwi", color: "green", threadId: "t0", mainThreadId: "t0", busy: true, tasks: tasks(), messages: [], ...extra } as unknown as Bot);

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; drawn.avatars = 0; });

const draw = (bot: Bot) => act(() => root!.render(createElement(HeaderThreadTabs, { bot })));
const selected = () => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-tab-id");

describe("thread tab strip while a reply streams", () => {
  it("does not draw its 60 tabs again for a bot update that changes none of them", () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    draw(kiwi());
    const first = drawn.avatars;
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(60);

    draw(kiwi({ messages: [{ id: "m1" } as Bot["messages"][number]], turnStartedAt: 5, activity: "working" } as Partial<Bot>));
    draw(kiwi({ tasks: tasks().map((one) => ({ ...one, lastActivityAt: 9 })) } as Partial<Bot>));
    expect(drawn.avatars).toBe(first);

    draw(kiwi({ tasks: tasks().map((one) => (one.threadId === "t3" ? { ...one, title: "Renamed" } : one)) }));
    expect(drawn.avatars).toBe(first + 1);
    expect(document.querySelector('[data-tab-id="t3"]')?.textContent).toContain("Renamed");

    draw(kiwi({ threadId: "t5" }));
    expect(selected()).toBe("t5");
    draw(kiwi({ threadId: "t5", name: "Kiwi Two" }));
    expect(document.querySelector("[data-thread-tabs-bot]")?.textContent).toBe("Kiwi Two");
  });

  it("draws its labels again in a new language, though the tabs did not change", () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    draw(kiwi());
    const list = () => document.querySelector('[role="tablist"]')?.getAttribute("aria-label");
    expect(list()).toBe("Kiwi threads");
    try {
      act(() => { setLocale("pt-br"); });
      expect(list()).toBe("Conversas de Kiwi");
    } finally {
      act(() => { setLocale("en"); });
    }
  });
});
