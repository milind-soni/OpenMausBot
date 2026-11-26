// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ bots: [] as Array<{ id: string; name: string }> }));
import { BotMoveLine, MoveChooser, MovedToMyCloudRow, useMoveToMyCloud } from "./MoveToMyCloud";

let container: HTMLDivElement, root: Root;
const page = { botChoices: vi.fn(async () => ({ bots: fixture.bots })), moveBots: vi.fn(async () => ({ available: true, moving: [] })), moveEverything: vi.fn(async () => ({ available: true, moving: [] })), botMoveState: vi.fn(async () => ({ available: true, moving: ["moving-one"] })),
  openMyCloud: vi.fn(async () => {}), botMoveRetry: vi.fn(async () => null), dismiss: vi.fn(async () => ({})) };
const onClose = vi.fn();
const named = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `b${i}`, name: i % 2 ? `Sales ${i}` : `Ops ${i}` }));
const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const click = async (element: HTMLElement | null) => { expect(element).toBeTruthy(); await act(async () => element!.click()); };
const render = async (bots: Array<{ id: string; name: string }>) => { fixture.bots = bots; await act(async () => root.render(createElement(MoveChooser, { onClose }))); await act(async () => {}); };
async function type(value: string) {
  const field = q("[data-move-search]") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.ogb = { cloudSendPage: page } as never;
  for (const fn of [page.moveBots, page.moveEverything, onClose]) fn.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); delete (window as { ogb?: unknown }).ogb; });

it("Move everything is one press, and closes the dialog", async () => {
  await render(named(4));
  await click(q("[data-move-everything]"));
  expect(page.moveEverything).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("moves only the bots ticked, and says how many", async () => {
  await render(named(4));
  expect((q("[data-move-chosen]") as HTMLButtonElement).disabled).toBe(true);
  await click(q('[data-move-bot="b1"]'));
  expect(q("[data-move-chosen]")!.textContent).toBe("Move 1 bot");
  await click(q('[data-move-bot="b3"]'));
  expect(q("[data-move-chosen]")!.textContent).toBe("Move 2 bots");
  expect(q('[data-move-bot="b3"]')!.getAttribute("aria-checked")).toBe("true");
  await click(q("[data-move-chosen]"));
  expect(page.moveBots).toHaveBeenCalledWith(["b1", "b3"], { commands: false, together: false });
});

it("offers the bots main lists, whichever page asks: a page's own bots are never what is moved", async () => {
  await render([{ id: "a", name: "Ada" }]);
  expect(page.botChoices).toHaveBeenCalled();
  expect(all("[data-move-bot]").map((row) => row.dataset.moveBot)).toEqual(["a"]);
});

it("with thousands of bots, shows a page at a time, finds any by name, and Select all takes everything found, not only what shows", async () => {
  await render(named(5_000));
  expect(all("[data-move-bot]")).toHaveLength(200);
  expect(q("[data-move-more]")!.textContent).toBe("Show 4800 more");
  await click(q("[data-move-more]"));
  expect(all("[data-move-bot]")).toHaveLength(400);
  await type("sales");
  expect(all("[data-move-bot]")).toHaveLength(200);
  await click(q("[data-move-select-all]"));
  expect(q("[data-move-chosen]")!.textContent).toBe("Move 2500 bots");
  expect(q("[data-move-select-all]")!.textContent).toBe("Clear");
  await click(q("[data-move-select-all]"));
  expect((q("[data-move-chosen]") as HTMLButtonElement).disabled).toBe(true);
  await type("no such bot");
  expect(q('[data-move-bots]')!.textContent).toBe("No bots match.");
});

it("says why when the move could not start, and stays open", async () => {
  page.moveEverything.mockRejectedValueOnce(new Error("Error invoking remote method 'cloud-send:move-everything': Error: This computer has no My Cloud yet."));
  await render(named(2));
  await click(q("[data-move-everything]"));
  expect(q('[role="alert"]')!.textContent).toBe("This computer has no My Cloud yet.");
  expect(onClose).not.toHaveBeenCalled();
});

function Menu({ bot }: { bot: Record<string, unknown> }) {
  const move = useMoveToMyCloud();
  const item = (_icon: unknown, label: string, onClick?: () => void) => createElement("button", { key: label, "data-item": "", onClick }, label);
  return createElement("div", null, ...move.items(bot as never, item as never), move.dialog);
}
const menu = async (bot: Record<string, unknown>) => { await act(async () => root.render(createElement(Menu, { bot }))); await act(async () => {}); };

it("a bot's menu offers Move to My Cloud, and it goes after one confirm", async () => {
  await menu({ id: "ada", name: "Ada" });
  await click(q("[data-item]"));
  expect(q("[data-bot-move-confirm]")!.textContent).toContain("Ada moves with its chats, memory, skills and routines, and works on My Cloud from then on. Your logins, saved secrets, profile and connections go too, except connections that only work on this computer.");
  expect(q("[data-bot-move-confirm]")!.textContent).toContain("Tables Ada loaded in Data don't move: they stay on this computer, where Ada can't open them once it lives on My Cloud.");
  await click(all("button").find((button) => button.textContent === "Move") ?? null);
  expect(page.moveBots).toHaveBeenCalledWith(["ada"], { commands: false, together: false });
});

const facts = { folder: "~/code/app", folders: 1, engine: "Ollama", tools: ["git"], skills: ["weekly-digest"], hidden: ["~/.claude"], teammates: ["Proofreader"] };
const noLending = { paused: false, folderLent: false, terminal: false };

it("before Move, says what changes for the bot from its real setup, four lines at most until asked for more", async () => {
  const moveChanges = vi.fn(async () => ({ facts, lending: noLending }));
  window.ogb = { cloudSendPage: { ...page, moveChanges } } as never;
  await menu({ id: "ada", name: "Ada" });
  await click(q("[data-item]"));
  await act(async () => {});
  expect(moveChanges).toHaveBeenCalledWith(["ada"]);
  const lines = () => all("[data-move-change]").map((line) => line.dataset.moveChange);
  expect(q("[data-move-changes]")!.textContent).toContain("What changes for Ada");
  expect(lines()).toEqual(["teammates", "folder", "engine", "commands"]);
  expect(all("[data-move-change]")[1]!.textContent).toBe("~/code/app stays on this computer; My Cloud reaches it while this computer is on.");
  await click(q("[data-move-changes-more]"));
  expect(lines()).toEqual(["teammates", "folder", "engine", "commands", "skills"]);
  expect(q("[data-move-changes-more]")).toBeNull();
});

it("the folder is lent by default, commands only when turned on, and the choice goes with Move", async () => {
  const moveChanges = vi.fn(async () => ({ facts: { ...facts, engine: null, skills: [], hidden: [], teammates: [] }, lending: noLending }));
  window.ogb = { cloudSendPage: { ...page, moveChanges } } as never;
  await menu({ id: "ada", name: "Ada" });
  await click(q("[data-item]"));
  await act(async () => {});
  const toggle = (id: string) => q(`[data-move-choice="${id}"] [role="switch"]`);
  expect(q('[data-move-choice="folder"]')!.textContent).toBe("Let Ada open and edit ~/code/app");
  expect(toggle("folder")!.getAttribute("aria-checked")).toBe("true");
  expect(toggle("commands")!.getAttribute("aria-checked")).toBe("false");
  expect(q('[data-move-choice="commands"]')!.textContent).toBe("Let your Clouds run commands on this computerAs you, for the bots on all your own Clouds, while this computer is on. You confirm on this computer and can turn it off from the OpenMausBot icon.");
  await click(toggle("commands"));
  expect(q("[data-move-change=commands]")).toBeNull();
  await click(toggle("folder"));
  expect(q("[data-move-change=folder]")!.textContent).toBe("~/code/app stays on this computer, out of My Cloud's reach.");
  await click(all("button").find((button) => button.textContent === "Move") ?? null);
  expect(page.moveBots).toHaveBeenCalledWith(["ada"], { folder: false, commands: true, together: false });
});

it("offers nothing already lent, and says so: a folder inside one lent and commands on leave only the facts", async () => {
  const moveChanges = vi.fn(async () => ({ facts: { ...facts, tools: [], skills: [], hidden: [], teammates: [], engine: null }, lending: { paused: false, folderLent: true, terminal: true } }));
  window.ogb = { cloudSendPage: { ...page, moveChanges } } as never;
  await menu({ id: "ada", name: "Ada" });
  await click(q("[data-item]"));
  await act(async () => {});
  expect(all("[data-move-change]").map((line) => line.dataset.moveChange)).toEqual(["folder"]);
  expect(q("[data-move-choice]")).toBeNull();
  await click(all("button").find((button) => button.textContent === "Move") ?? null);
  expect(page.moveBots).toHaveBeenCalledWith(["ada"], { commands: false, together: false });
});

it("while lending is paused it says so, offers nothing, and leaves the folder to be lent as moves always did once it resumes", async () => {
  const moveChanges = vi.fn(async () => ({ facts: { ...facts, tools: [], skills: [], hidden: [], teammates: [], engine: null }, lending: { paused: true, folderLent: false, terminal: false } }));
  window.ogb = { cloudSendPage: { ...page, moveChanges } } as never;
  await menu({ id: "ada", name: "Ada" });
  await click(q("[data-item]"));
  await act(async () => {});
  expect(q("[data-move-change=folder]")!.textContent).toBe("~/code/app stays on this computer; lending to My Cloud is paused, so it can't reach it.");
  expect(q("[data-move-choice]")).toBeNull();
  await click(all("button").find((button) => button.textContent === "Move") ?? null);
  expect(page.moveBots).toHaveBeenCalledWith(["ada"], { commands: false, together: false });
});

it("in the chooser, a folder turned off stays off even when Move is pressed before the new choice is read", async () => {
  const moveChanges = vi.fn(async () => ({ facts: { ...facts, engine: null, tools: [], skills: [], hidden: [], teammates: [] }, lending: noLending }));
  window.ogb = { cloudSendPage: { ...page, moveChanges } } as never;
  await render(named(4));
  await click(q('[data-move-bot="b1"]'));
  await act(async () => {});
  await click(q('[data-move-choice="folder"] [role="switch"]'));
  await click(q('[data-move-bot="b3"]'));
  await click(q("[data-move-chosen]"));
  expect(moveChanges).toHaveBeenCalledTimes(1);
  expect(page.moveBots).toHaveBeenCalledWith(["b1", "b3"], { folder: false, commands: false, together: false });
});

it("the move's line says when commands asked for with it could not be turned on, in main's words", async () => {
  const move = { bot: { id: "bots-1", name: "Ada" }, team: { id: "my-cloud", name: "My Cloud" }, phase: "moving" as const, bots: 1, commandsError: "Sign in to the Cloud before lending it the terminal." };
  await act(async () => root.render(createElement(BotMoveLine, { move, onChange: vi.fn() })));
  expect(q("[data-bot-move-commands-failed]")!.textContent).toBe("Commands on this computer weren't turned on: Sign in to the Cloud before lending it the terminal.");
  await act(async () => root.render(createElement(BotMoveLine, { move: { ...move, commandsError: undefined }, onChange: vi.fn() })));
  expect(q("[data-bot-move-commands-failed]")).toBeNull();
});

it("in the chooser, what the person turned off stays off while they tick more bots", async () => {
  const moveChanges = vi.fn(async () => ({ facts: { ...facts, engine: null, tools: [], skills: [], hidden: [], teammates: [] }, lending: noLending }));
  window.ogb = { cloudSendPage: { ...page, moveChanges } } as never;
  await render(named(4));
  await click(q('[data-move-bot="b1"]'));
  await act(async () => {});
  await click(q('[data-move-choice="folder"] [role="switch"]'));
  await click(q('[data-move-bot="b3"]'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(moveChanges).toHaveBeenLastCalledWith(["b1", "b3"]);
  expect(q('[data-move-choice="folder"] [role="switch"]')!.getAttribute("aria-checked")).toBe("false");
  await click(q("[data-move-chosen]"));
  expect(page.moveBots).toHaveBeenCalledWith(["b1", "b3"], { folder: false, commands: false, together: false });
});

it("the chooser says what changes for the bots ticked, and sends the choice with them", async () => {
  const moveChanges = vi.fn(async () => ({ facts: { ...facts, folders: 2, engine: null, tools: [], skills: [], hidden: [], teammates: [] }, lending: noLending }));
  window.ogb = { cloudSendPage: { ...page, moveChanges } } as never;
  await render(named(4));
  expect(q("[data-move-changes]")).toBeNull();
  await click(q('[data-move-bot="b1"]'));
  await click(q('[data-move-bot="b3"]'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(moveChanges).toHaveBeenCalledTimes(2);
  expect(moveChanges).toHaveBeenLastCalledWith(["b1", "b3"]);
  expect(q("[data-move-changes]")!.textContent).toContain("What changes for these bots");
  expect(q("[data-move-change=folder]")!.textContent).toBe("2 folders, such as ~/code/app, stay on this computer; My Cloud reaches them while this computer is on.");
  expect(q('[data-move-choice="folder"]')!.textContent).toBe("Let these bots open and edit their folders");
  await click(q("[data-move-chosen]"));
  expect(page.moveBots).toHaveBeenCalledWith(["b1", "b3"], { folder: true, commands: false, together: false });
});

it("a bot's menu leaves it out for the helper, a bot on its way, and when My Cloud can't take bots", async () => {
  await menu({ id: "maus", name: "Maus", defaultBot: { v: 1 } });
  expect(q("[data-item]")).toBeNull();
  await menu({ id: "moving-one", name: "Pip" });
  expect(q("[data-item]")).toBeNull();
  page.botMoveState.mockResolvedValueOnce({ available: false, moving: [] });
  await act(async () => root.unmount());
  root = createRoot(container);
  await menu({ id: "ada", name: "Ada" });
  expect(q("[data-item]")).toBeNull();
});

it("however many bots moved, the sidebar keeps one row, which opens My Cloud; a bot moved into a team is not on it", async () => {
  const moved = (id: string, team = "my-cloud") => ({ id, name: id, movedTo: { state: "moved", team: { id: team, name: team } } });
  await act(async () => root.render(createElement(MovedToMyCloudRow, { bots: [moved("a"), moved("b"), moved("c", "team-acme")] as never })));
  const row = q("[data-moved-to-my-cloud]");
  expect(row!.textContent).toBe("2 bots live on My Cloud");
  await click(row);
  expect(page.openMyCloud).toHaveBeenCalled();
});

it("the line says how the move goes, and Try again and Open My Cloud reach main", async () => {
  const move = (phase: "moving" | "failed" | "done") => ({ bot: { id: "bots-1", name: "Ada" }, team: { id: "my-cloud", name: "My Cloud" }, phase, bots: 12 });
  const onChange = vi.fn();
  await act(async () => root.render(createElement(BotMoveLine, { move: move("failed"), onChange })));
  expect(q("[data-cloud-send-strip-line]")!.textContent).toBe("12 bots couldn't move to My Cloud yet. They're still here, and it tries again by itself.");
  await click(all("button").find((button) => button.textContent === "Try again") ?? null);
  expect(page.botMoveRetry).toHaveBeenCalled();
  await act(async () => root.render(createElement(BotMoveLine, { move: move("done"), onChange })));
  await click(all("button").find((button) => button.textContent === "Open My Cloud") ?? null);
  expect(page.openMyCloud).toHaveBeenCalled();
});
