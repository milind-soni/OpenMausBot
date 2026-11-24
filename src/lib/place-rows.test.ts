// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { setLocale } from "./i18n";
import { isPlacedBot, otherPlaceDispatch, ownRows, placedBot, placedLine, placeMark, resetPlaceRowsForTest, withOtherPlace } from "./place-rows";
import type { PlaceBotRow } from "./places-together";
import { partitionSidebarBots, sidebarBotRows } from "./sidebar-layout";

const row = (home: "computer" | "cloud", id: string, over: Partial<PlaceBotRow> = {}): PlaceBotRow => ({ home, id, threadId: `t-${id}`, name: id, color: "blue", ...over });
const own = (id: string, over: Partial<Bot> = {}): Bot => ({ id, name: id, threadId: `${id}-t`, title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "here", model: "m" }, ...over });

beforeEach(() => setLocale("en"));
afterEach(() => { resetPlaceRowsForTest(); vi.unstubAllGlobals(); delete (window as { ogb?: unknown }).ogb; });

describe("a row of the other place as a bot of the one list", () => {
  it("is keyed by its place and its id, so the same id in two places is two bots", () => {
    const there = placedBot(row("cloud", "scout"), "ready"), here = own("scout");
    expect(there.id).toBe("cloud:scout");
    expect(there.threadId).toBe("cloud:t-scout");
    expect(placedBot(row("computer", "scout"), "ready").id).toBe("computer:scout");
    expect(new Set([here.id, there.id]).size).toBe(2);
    expect(isPlacedBot(there)).toBe(true);
    expect(isPlacedBot(here)).toBe(false);
  });

  it("carries a name, a look, a state and a time, and nothing of the other place's engine or settings", () => {
    const bot = placedBot(row("cloud", "nova", { name: "Nova", title: "Research", color: "pink", mascotBody: "classic", unread: true, working: true, chief: true, lastAt: 42 }), "asleep");
    expect(bot).toMatchObject({ name: "Nova", title: "Research", color: "pink", unread: true, busy: true, activity: "working", lastAt: 42, messages: [] });
    expect(bot.placedFrom).toEqual({ home: "cloud", id: "nova", health: "asleep" });
    expect(bot.modelSelection).toEqual({ instanceId: "", model: "" });
    // The Chief stays where it started: the other place's is an ordinary row here.
    expect(bot.chiefOfStaff).toBeUndefined();
    expect(placedBot(row("cloud", "w", { waiting: true }), "ready").activity).toBe("waiting-on-you");
    expect(placedBot(row("cloud", "x", { color: "url(javascript:1)" }), "ready").color).toBe("green");
  });

  it("shows its title as its second line in Simple, and nothing in Advanced, whose row shows it as the role", () => {
    const bot = placedBot(row("cloud", "nova", { title: "Research" }), "ready");
    expect(placedLine(bot, false)).toBe("Research");
    expect(placedLine(bot, true)).toBe("");
  });
});

describe("one list: the other place's rows among this place's own", () => {
  const list = (bots: Bot[], placed: Bot[]) => {
    const parts = withOtherPlace(partitionSidebarBots(bots), placed.filter(isPlacedBot));
    return sidebarBotRows(parts, (bot) => Boolean(bot.busy) || bot.activity === "waiting-on-you");
  };

  it("joins the main list after this place's own, and working bots of either place float to the top together", () => {
    const placed = [placedBot(row("cloud", "scout"), "ready"), placedBot(row("cloud", "atlas", { working: true }), "ready")];
    const rows = list([own("chief", { chiefOfStaff: true }), own("git"), own("ledger", { busy: true })], placed);
    expect(rows.unsectionedBots.map((bot) => bot.id)).toEqual(["ledger", "cloud:atlas", "git", "cloud:scout"]);
  });

  it("this place's Chief keeps its place; the other place's Chief is a row, so both are listed", () => {
    const parts = withOtherPlace(partitionSidebarBots([own("chief", { chiefOfStaff: true }), own("git")]), [placedBot(row("cloud", "maus", { chief: true }), "ready")]);
    expect(parts.unsectionedChief?.id).toBe("chief");
    expect(parts.unsectionedBots.map((bot) => bot.id)).toEqual(["git", "cloud:maus"]);
  });

  it("unread rows of both places go into one Unread group, newest first, by each row's own time", () => {
    const placed = [placedBot(row("cloud", "old", { unread: true, lastAt: 100 }), "ready"), placedBot(row("cloud", "new", { unread: true, lastAt: 900 }), "ready"), placedBot(row("cloud", "read"), "ready")];
    const mid = own("mid", { unread: true, messages: [{ id: "m", role: "bot", kind: "text", text: "hi", at: 500 } as Bot["messages"][number]] });
    const rows = list([mid, own("quiet")], placed);
    expect(rows.unreadBots.map((bot) => bot.id)).toEqual(["cloud:new", "mid", "cloud:old"]);
    expect(rows.unreadCount).toBe(3);
    expect(rows.unsectionedBots.map((bot) => bot.id)).toEqual(["quiet", "cloud:read"]);
  });

  it("a drag or Alt+Up/Down arranges and saves this place's own rows only", () => {
    const placed = placedBot(row("cloud", "scout"), "ready");
    const rows = list([own("a"), own("b")], [placed]);
    expect(rows.inPlace.unsectionedBots.map((bot) => bot.id)).toEqual(["a", "b", "cloud:scout"]);
    expect(ownRows(rows.inPlace.unsectionedBots).map((bot) => bot.id)).toEqual(["a", "b"]);
    const plain = [own("a")];
    expect(ownRows(plain)).toBe(plain);
  });

  it("with no rows of the other place, the parts are handed back as they were", () => {
    const parts = partitionSidebarBots([own("a")]);
    expect(withOtherPlace(parts, [])).toBe(parts);
  });
});

describe("what a row of the other place does", () => {
  it("choosing it opens its bot where it lives, by its own id there, once per click; nothing else is sent anywhere", async () => {
    const open = vi.fn(async () => true);
    window.ogb = { placesTogether: { open } } as never;
    const bot = placedBot(row("cloud", "scout"), "ready");
    const send = otherPlaceDispatch(bot);
    expect(otherPlaceDispatch(bot)).toBe(send);
    send({ type: "select", id: bot.id });
    send({ type: "switchTask", botId: bot.id, threadId: bot.threadId });
    expect(open.mock.calls).toEqual([["scout"]]);
    await Promise.resolve();
    send({ type: "updateBot", botId: bot.id, patch: { name: "Renamed" } } as never);
    send({ type: "newTask", botId: bot.id } as never);
    expect(open).toHaveBeenCalledTimes(1);
    send({ type: "select", id: bot.id });
    expect(open.mock.calls).toEqual([["scout"], ["scout"]]);
  });
});

describe("the device mark", () => {
  it("names where the bot lives, on hover and keyboard focus only, while there is nothing more to say", () => {
    expect(placeMark("computer", "ready", false, "Git")).toEqual({ home: "computer", icon: "computer", label: "On this computer", shows: "hover" });
    expect(placeMark("cloud", "ready", false, "Scout")).toEqual({ home: "cloud", icon: "cloud", label: "On My Cloud", shows: "hover" });
    expect(placeMark("cloud", "loading", false, "Scout").shows).toBe("hover");
  });

  it("stays while the bot works, and says where", () => {
    expect(placeMark("cloud", "ready", true, "Scout")).toEqual({ home: "cloud", icon: "cloud", label: "Working on My Cloud now", shows: "always" });
    expect(placeMark("computer", "ready", true, "Git")).toEqual({ home: "computer", icon: "computer", label: "Working on this computer now", shows: "always" });
  });

  it("stays while My Cloud sleeps, wakes or can't be reached, in quiet words, never as an error", () => {
    expect(placeMark("cloud", "asleep", false, "Atlas")).toEqual({ home: "cloud", icon: "cloud-asleep", label: "My Cloud is asleep. Opening Atlas wakes it.", shows: "always" });
    expect(placeMark("cloud", "asleep", true, "Atlas").icon).toBe("cloud-asleep");
    expect(placeMark("cloud", "waking", false, "Atlas")).toEqual({ home: "cloud", icon: "cloud-waking", label: "My Cloud is waking up…", shows: "always" });
    expect(placeMark("cloud", "offline", false, "Scout")).toEqual({ home: "cloud", icon: "cloud-off", label: "My Cloud can't be reached right now. Scout carries on when it's back.", shows: "always" });
    expect(placeMark("computer", "offline", false, "Git")).toEqual({ home: "computer", icon: "computer-off", label: "This computer's bots can't be read right now.", shows: "always" });
  });

  it("speaks the person's language", () => {
    setLocale("pt-br");
    expect(placeMark("cloud", "ready", false, "Scout").label).toBe("No My Cloud");
    expect(placeMark("cloud", "asleep", false, "Atlas").label).toBe("O My Cloud está em repouso. Abrir Atlas o ativa.");
  });
});
