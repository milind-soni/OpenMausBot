import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";
import { SetupOffer, SetupRequestChip, setupRequestPlaceholder } from "./SetupOffer";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, api: vi.fn(), focus: vi.fn(), dispatch: vi.fn(), bots: [] as unknown[], instances: [] as unknown[], reactor: "user" }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { bots: fixture.bots, instances: fixture.instances }, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/cloud-guest", () => ({ useReactor: () => fixture.reactor, currentReactor: () => fixture.reactor }));
vi.mock("./AskCard", async (original) => ({ ...await original<typeof import("./AskCard")>(), returnFocusToComposer: fixture.focus }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Children.toArray(value).flatMap((child) => (isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []));

const greeting: Message = { id: "g1", role: "bot", kind: "text", at: 1, text: "Hi, I'm Ava. What would you like me to do?", setupOffer: true } as Message;
const bot = (extra: Partial<Bot> = {}): Bot => ({ id: "b1", threadId: "t1", name: "Ava", title: "", description: "", soul: "",
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, tasks: [{ threadId: "t1", title: "New thread", createdAt: 1 }], ...extra }) as Bot;
const CANNED: Message = { id: "m2", role: "bot", kind: "text", at: 2, text: "Great. Tell me what you'd like help with." } as Message;

function renderOffer(message: Message, transcript: Message[] = [message]) {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = SetupOffer({ botId: "b1", threadId: "t1", message, transcript }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  return { html, card: all.find((node) => node.props["data-setup-card"] !== undefined),
    choices: all.filter((node) => node.props["data-ask-choice"] !== undefined),
    close: all.find((node) => node.props["aria-label"] === "Close") };
}
const press = (node: Node | undefined) => (node!.props.onClick as () => void)();
const key = (card: Node | undefined, value: string) => {
  const event = { key: value, preventDefault: vi.fn(), metaKey: false, ctrlKey: false, altKey: false };
  (card!.props.onKeyDown as (event: unknown) => void)(event);
  return event;
};

function renderChip(of: Bot) {
  let tree: ReactNode = null;
  // The chip draws its inner part only while waiting; call that part here too, so its button can be pressed.
  function Capture() {
    fixture.index = 0;
    const outer = SetupRequestChip({ bot: of, threadId: "t1" });
    tree = isValidElement(outer) && typeof outer.type === "function" ? (outer.type as (props: unknown) => ReactNode)(outer.props) : outer;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, close: nodes(tree).find((node) => node.props["data-setup-request-cancel"] !== undefined) };
}

beforeEach(() => {
  fixture.values = [];
  fixture.api.mockReset().mockResolvedValue({ ok: true, message: CANNED });
  fixture.focus.mockReset();
  fixture.dispatch.mockReset();
  fixture.bots = [bot()];
  fixture.instances = [{ instanceId: "claude", capabilities: { agentsMcp: true } }];
  fixture.reactor = "user";
});

describe("the setup card under a new bot's greeting", () => {
  const offered = { ...greeting, setupChoices: ["Plan my trips", "Watch the news"] } as Message;
  const label = (node: Node) => nodes(node.props.children).map((child) => child.props.children).filter((text) => typeof text === "string").join("|");

  it("asks what to help with first, with the greeting's own answers lettered in order, then Something else", () => {
    const view = renderOffer(offered);
    expect(view.html).toContain("What should I help you with first?");
    expect(view.choices.map(label)).toEqual(["A|Plan my trips", "B|Watch the news", "C|Something else"]);
  });

  it("offers its own answers on an older greeting that carries none", () => {
    expect(renderOffer(greeting).choices.map((node) => label(node).split("|")[1])).toEqual(["Research and digging into topics", "Keeping an eye on things for me", "Email, calendar and messages", "Bookings, shopping and errands", "Data, spreadsheets and reports", "Something else"]);
  });

  it("is not shown for a bot given a role or instructions, when the AI cannot set the bot up, or once closed", () => {
    fixture.bots = [bot({ soul: "Only water the garden." })];
    expect(renderOffer(offered).html).toBe("");
    fixture.bots = [bot({ description: "Files bugs." })];
    expect(renderOffer(offered).html).toBe("");
    fixture.bots = [bot()];
    fixture.instances = [{ instanceId: "claude", capabilities: { agentsMcp: false } }];
    expect(renderOffer(offered).html).toBe("");
    fixture.instances = [{ instanceId: "plain", capabilities: {} }, { instanceId: "claude", capabilities: { agentsMcp: true } }];
    fixture.bots = [bot({ tasks: [{ threadId: "t1", title: "New thread", createdAt: 1, modelSelection: { instanceId: "plain", model: "m" } }] })];
    expect(renderOffer(offered).html).toBe("");
    expect(renderOffer({ ...offered, setupOffer: undefined } as Message).html).toBe("");
  });

  it("sends a pick's words, once, and puts the cursor in the message box", async () => {
    const view = renderOffer(offered);
    press(view.choices[1]);
    press(view.choices[1]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/bots/b1/setup-request", { method: "POST", body: JSON.stringify({ threadId: "t1", text: "Watch the news" }) });
    expect(fixture.focus).toHaveBeenCalled();
  });

  it("asks for Something else without words, and shows the bot's line from that answer even if the live update never comes", async () => {
    press(renderOffer(offered).choices.at(-1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/setup-request", { method: "POST", body: JSON.stringify({ threadId: "t1" }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "messageAdded", threadId: "t1", message: CANNED });
  });

  it("picks with the answer's letter key, and leaves other keys alone", async () => {
    const view = renderOffer(offered);
    expect(key(view.card, "b").preventDefault).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/setup-request", { method: "POST", body: JSON.stringify({ threadId: "t1", text: "Watch the news" }) });
    fixture.api.mockClear();
    expect(key(renderOffer(offered).card, "z").preventDefault).not.toHaveBeenCalled();
    expect(key(renderOffer(offered).card, "Enter").preventDefault).not.toHaveBeenCalled();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("settles once answered: the answers go quiet and the answer shows", () => {
    const picked = { id: "u1", role: "user", kind: "text", at: 2, text: "Watch the news", setupRequest: true } as Message;
    const settled = renderOffer(offered, [offered, picked]);
    expect(settled.html).toContain("Your answer");
    expect(settled.html).toContain("Watch the news");
    expect(settled.choices.every((node) => node.props.disabled === true)).toBe(true);
    expect(settled.close).toBeUndefined();
    expect(settled.card!.props.onKeyDown).toBeUndefined();
    fixture.bots = [bot({ soul: "Watches the news." })];
    expect(renderOffer(offered, [offered, picked]).html, "the answer stays after the bot is set up").toContain("Your answer");
  });

  it("settles quietly, with no answer, when the person writes something else first", () => {
    for (const text of ["What's the weather in Paris?", "/learn the inbox"]) {
      const view = renderOffer(offered, [offered, { id: "u1", role: "user", kind: "text", at: 2, text } as Message]);
      expect(view.html).toContain("What should I help you with first?");
      expect(view.html).not.toContain("Your answer");
      expect(view.choices.every((node) => node.props.disabled === true)).toBe(true);
    }
    fixture.instances = [{ instanceId: "claude", capabilities: { agentsMcp: false } }];
    expect(renderOffer(offered, [offered, { id: "u1", role: "user", kind: "text", at: 2, text: "hello" } as Message]).html, "never drawn, never settled").toBe("");
  });

  it("closes with its x", async () => {
    press(renderOffer(offered).close);
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/setup-request", { method: "DELETE", body: JSON.stringify({ threadId: "t1" }) });
    expect(renderOffer(offered).html).toBe("");
  });

  it("says why when a pick is refused", async () => {
    fixture.api.mockRejectedValue(new Error("This bot is already set up."));
    press(renderOffer(offered).choices[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderOffer(offered).html).toContain("This bot is already set up.");
  });
});

describe("while the bot waits for what to set itself up for", () => {
  const waiting = bot({ tasks: [{ threadId: "t1", title: "New thread", createdAt: 1, setupRequest: { at: 2 } }] });

  it("says so above the message box, with an x that stops it", async () => {
    const chip = renderChip(waiting);
    expect(chip.html).toContain("Ava is ready to be set up");
    (chip.close!.props.onClick as () => void)();
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/setup-request", { method: "DELETE", body: JSON.stringify({ threadId: "t1" }) });
  });

  it("asks for the job in the message box", () => {
    expect(setupRequestPlaceholder(waiting, "t1")).toBe("Tell Ava what you'd like help with");
  });

  it("is only the presser's where people share the place", () => {
    const theirs = bot({ tasks: [{ threadId: "t1", title: "New thread", createdAt: 1, setupRequest: { at: 2, by: "member-a" } }] });
    fixture.reactor = "member-b";
    expect(renderChip(theirs).html).toBe("");
    expect(setupRequestPlaceholder(theirs, "t1")).toBeUndefined();
    fixture.reactor = "member-a";
    expect(renderChip(theirs).html).toContain("Ava is ready to be set up");
    expect(setupRequestPlaceholder(theirs, "t1")).toBe("Tell Ava what you'd like help with");
  });

  it("shows nothing in a conversation that is not waiting", () => {
    expect(renderChip(bot()).html).toBe("");
    expect(setupRequestPlaceholder(bot(), "t1")).toBeUndefined();
    expect(setupRequestPlaceholder(waiting, "t2")).toBeUndefined();
    expect(setupRequestPlaceholder(undefined, "t1")).toBeUndefined();
  });
});
