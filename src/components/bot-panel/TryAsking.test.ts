// @vitest-environment happy-dom
// MausBot's example asks live in its panel in Simple mode: a tap sends one.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const f = vi.hoisted(() => ({ advanced: false, dispatch: vi.fn() }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => f.advanced }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: f.dispatch }) }));
vi.mock("../HelperIntro", () => ({ HELPER_ASK_KEYS: ["helperIntro.ask.overview", "helperIntro.ask.inbox", "helperIntro.ask.routine", "helperIntro.ask.howto"] }));
const { TryAsking } = await import("./TryAsking");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bot = (extra: Partial<Bot> = {}) => ({ id: "maus", threadId: "t", name: "MausBot", defaultBot: {}, ...extra }) as Bot;
let host: HTMLDivElement, root: Root;
const show = async (target: Bot) => { await act(async () => { root.render(createElement(TryAsking, { bot: target })); }); };

beforeEach(() => {
  setLocale("en");
  f.advanced = false;
  f.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Try asking", () => {
  it("lists MausBot's four asks, and a tap sends one in the open conversation", async () => {
    await show(bot());
    const asks = [...host.querySelectorAll<HTMLButtonElement>("[data-panel-ask]")];
    expect(host.textContent).toContain("Try asking");
    expect(asks.map((ask) => ask.textContent)).toEqual(["What are my bots up to?", "Set up a bot for my inbox", "Make me a morning routine", "How do I connect my email?"]);
    await act(async () => { asks[1]!.click(); });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "send", botId: "maus", text: "Set up a bot for my inbox", threadId: "t" });
  });

  it("is MausBot's alone, and Simple mode's", async () => {
    await show(bot({ defaultBot: undefined }));
    expect(host.textContent).toBe("");
    f.advanced = true;
    await show(bot());
    expect(host.textContent).toBe("");
  });
});
