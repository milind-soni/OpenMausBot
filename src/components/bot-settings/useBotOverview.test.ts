// @vitest-environment happy-dom
// A read first flushes the bot's patch queue. The Advanced accordion's Overview follows every edit; the Simple bot
// panel, whose Details tab edits the same facts inline, must never save and re-read once per keystroke.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  flush: vi.fn(),
  state: { routines: [] as unknown[], webhooks: [] as unknown[] },
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: fixture.state, dispatch: vi.fn(), flushBotPatches: fixture.flush }),
}));

const { useBotOverview } = await import("./useBotOverview");

const bot = (extra: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "Be brief.",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
  ...extra,
});

let host: HTMLDivElement;
let root: Root;
function Probe({ of, want }: { of: Bot; want: Parameters<typeof useBotOverview>[1] }) {
  useBotOverview(of, want);
  return null;
}
const render = (of: Bot, want: Parameters<typeof useBotOverview>[1]) => flushSync(() => root.render(createElement(Probe, { of, want })));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const reads = () => fixture.api.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  fixture.api.mockReset().mockResolvedValue({});
  fixture.flush.mockReset().mockResolvedValue(null);
  fixture.state = { routines: [], webhooks: [] };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("reading a bot's overview", () => {
  it("re-reads after each edit by default, as the Advanced accordion's Overview always has", async () => {
    render(bot(), { overview: true, prompt: false });
    await settle();
    render(bot({ soul: "Be brief. Cite" }), { overview: true, prompt: false });
    await settle();
    expect(fixture.flush).toHaveBeenCalledTimes(2);
    expect(reads()).toEqual(["/api/bots/scout/overview", "/api/bots/scout/overview"]);
  });

  it("never flushes or re-reads on edits when it reads on demand, however many keystrokes land", async () => {
    render(bot(), { overview: true, prompt: false, followEdits: false });
    await settle();
    for (const soul of ["Be brief. C", "Be brief. Ci", "Be brief. Cit", "Be brief. Cite"]) {
      render(bot({ soul, name: `Scout ${soul.length}`, description: soul }), { overview: true, prompt: false, followEdits: false });
      await settle();
    }
    fixture.state = { routines: [{}], webhooks: [{}] };
    render(bot({ soul: "Be brief. Cite" }), { overview: true, prompt: false, followEdits: false });
    await settle();
    expect(fixture.flush).toHaveBeenCalledTimes(1);
    expect(reads()).toEqual(["/api/bots/scout/overview"]);
  });

  it("reads again on demand when a view that shows it asks, and the prompt only when that is asked for", async () => {
    const edited = bot({ soul: "Be brief. Cite sources." });
    render(bot(), { overview: true, prompt: false, followEdits: false });
    await settle();
    render(edited, { overview: false, prompt: false, followEdits: false });
    await settle();
    render(edited, { overview: true, prompt: true, followEdits: false });
    await settle();
    expect(fixture.flush).toHaveBeenCalledTimes(2);
    expect(reads()).toEqual(["/api/bots/scout/overview", "/api/bots/scout/overview", "/api/bots/scout/system-prompt"]);
  });
});
