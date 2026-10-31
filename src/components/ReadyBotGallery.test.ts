// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => ({ props: null as null | { readyBotId?: string; onClose?: () => void; onCreated?: (bot: { id: string }) => void }, dispatch: vi.fn() }));
vi.mock("./lazy-screens", () => ({
  NewBotDialog: (props: NonNullable<typeof opened.props>) => { opened.props = props; return null; },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ dispatch: opened.dispatch }) }));

const { ReadyBotGallery } = await import("./ReadyBotGallery");
const { READY_BOTS } = await import("@/lib/ready-bots");

let root: Root;
let host: HTMLElement;
const onDialog = vi.fn();
const onAdded = vi.fn();

function render(search = "", stats?: Record<string, { stars?: number; installs?: number }>) {
  flushSync(() => root.render(createElement(ReadyBotGallery, { search, onDialog, onAdded, ...(stats ? { stats } : {}) })));
}
const cards = () => [...host.querySelectorAll("[data-ready-bot]")].map((card) => card.getAttribute("data-ready-bot"));
const button = (name: string) => [...host.querySelectorAll("button")].find((candidate) =>
  candidate.textContent === name || candidate.getAttribute("aria-label") === name)!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  opened.props = null;
  opened.dispatch.mockReset();
  onDialog.mockClear();
  onAdded.mockClear();
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("ready-made bots gallery", () => {
  it("shows every ready-made bot with its own Add button", () => {
    render();
    expect(cards()).toEqual(READY_BOTS.map((bot) => bot.id));
    const labels = [...host.querySelectorAll("button[aria-label^='Add ']")].map((add) => add.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(READY_BOTS.length);
    expect(host.textContent).toContain("Try: “Add my monstera: living room, bright indirect light”");
    expect(host.textContent).toContain("Includes a paused routine");
  });

  it("gives every card the same parts: role, two-line description, one Try line, and a one-line footer with its category", () => {
    render();
    for (const bot of READY_BOTS) {
      const card = host.querySelector(`[data-ready-bot="${bot.id}"]`)!;
      expect(card.querySelector("[data-ready-bot-role]")!.textContent).toBe(bot.title);
      const description = card.querySelector("[data-ready-bot-description]")!;
      expect(description.className).toContain("line-clamp-2");
      expect(description.getAttribute("title")).toBe(bot.description);
      const tryLine = card.querySelector("[data-ready-bot-try]")!;
      expect(tryLine.className).toContain("truncate");
      expect(tryLine.getAttribute("title")).toContain(bot.tryAsking[0]!);
      const footer = card.querySelector("[data-ready-bot-footer]")!;
      expect(footer.querySelector("[data-ready-bot-about]")!.children[0]!.textContent, bot.id).toMatch(/^(Everyday|Work|Writing|Design|Sales|Personal)$/);
    }
  });

  it("puts apps and the routine on the one footer line, and a bot without apps still has its footer", () => {
    render();
    const withBoth = READY_BOTS.find((bot) => bot.apps.length > 0 && bot.routines?.length)!;
    const footer = host.querySelector(`[data-ready-bot="${withBoth.id}"] [data-ready-bot-footer]`)!;
    expect(footer.textContent).toContain("Works with");
    expect(footer.textContent).toContain("Routine");
    expect(footer.querySelector('[title="Includes a paused routine"]')).not.toBeNull();
    const plain = READY_BOTS.find((bot) => bot.apps.length === 0 && !bot.routines?.length)!;
    const plainFooter = host.querySelector(`[data-ready-bot="${plain.id}"] [data-ready-bot-footer]`)!;
    expect(plainFooter.querySelector("[data-ready-bot-about]")!.children).toHaveLength(1);
    expect(host.querySelector(`[data-ready-bot="${plain.id}"] [data-ready-bot-role]`)!.textContent).not.toContain("·");
  });

  it("shows stars and Used by only for templates the community catalog has numbers for", () => {
    render();
    expect(host.querySelector("[data-ready-bot-signals]")).toBeNull();
    render("", { assistant: { stars: 128, installs: 2400 }, inbox: { installs: 31 } });
    const assistant = host.querySelector('[data-ready-bot="assistant"] [data-ready-bot-signals]')!;
    expect(assistant.textContent).toContain("128");
    expect(assistant.textContent).toContain("128 stars from the community");
    expect(assistant.textContent).toMatch(/2\.4K/i);
    expect(assistant.textContent).toContain("Used by 2400");
    const inbox = host.querySelector('[data-ready-bot="inbox"] [data-ready-bot-signals]')!;
    expect(inbox.textContent).toBe("31Used by 31");
    expect(host.querySelector('[data-ready-bot="scout"] [data-ready-bot-signals]')).toBeNull();
  });

  it("keeps the same order on every card: category, Routine, apps on the left; numbers alone on the right", () => {
    render("", { assistant: { stars: 128, installs: 2400 } });
    for (const bot of READY_BOTS) {
      const footer = host.querySelector(`[data-ready-bot="${bot.id}"] [data-ready-bot-footer]`)!;
      const parts = [...footer.children].map((child) => child.getAttribute("data-ready-bot-about") !== null ? "about" : child.getAttribute("data-ready-bot-stats") !== null ? "stats" : "other");
      expect(parts, bot.id).toEqual(["about", "stats"]);
      const about = footer.querySelector("[data-ready-bot-about]")!;
      const routine = about.querySelector("[data-ready-bot-routine]");
      if (bot.routines?.length) expect([...about.children].indexOf(routine!), bot.id).toBe(1);
      else expect(routine).toBeNull();
    }
    expect(host.querySelector('[data-ready-bot="inbox"] [data-ready-bot-stats]')!.textContent).toBe("");
  });

  it("leaves the numbers' slot out of every card while no template has numbers", () => {
    render();
    expect(host.querySelector("[data-ready-bot-stats]")).toBeNull();
    render("", { assistant: {} });
    expect(host.querySelector("[data-ready-bot-stats]")).toBeNull();
  });

  it("narrows to a category and back to all", () => {
    render();
    flushSync(() => button("Design").click());
    expect(cards()).toEqual(["design-critic"]);
    expect(button("Design").getAttribute("aria-pressed")).toBe("true");
    flushSync(() => button("All").click());
    expect(cards()).toHaveLength(READY_BOTS.length);
  });

  it("follows the Templates search and hides itself when nothing matches", () => {
    render("plant");
    expect(cards()).toEqual(["plant-care"]);
    render("no bot is called this");
    expect(host.querySelector("section")).toBeNull();
  });

  it("opens New bot filled in with the chosen bot, and tells Templates to step aside", () => {
    render();
    flushSync(() => button("Add Fern, Plant care log").click());
    expect(opened.props?.readyBotId).toBe("plant-care");
    expect(onDialog).toHaveBeenLastCalledWith(true);
    opened.props!.onCreated!({ id: "new-bot" });
    expect(onAdded).toHaveBeenCalledWith({ id: "new-bot" });
    expect(onDialog).toHaveBeenLastCalledWith(false);
  });

  it("on a paired device, which cannot read the host's defaults, makes the bot at once", () => {
    vi.stubGlobal("ogb", { remoteClient: { active: true } });
    render();
    flushSync(() => button("Add Fern, Plant care log").click());
    expect(opened.props).toBeNull();
    expect(opened.dispatch).toHaveBeenCalledWith({ type: "newBot", onCreated: onAdded });
  });

  it("gives Templates its keys back when New bot is closed without creating", () => {
    render();
    flushSync(() => button("Add Echo, Humanizer").click());
    flushSync(() => opened.props!.onClose!());
    expect(onDialog).toHaveBeenLastCalledWith(false);
    expect(onAdded).not.toHaveBeenCalled();
  });
});
