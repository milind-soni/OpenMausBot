import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { OneWorkspaceView, RosterBot, SideRoster } from "../../shared/one-workspace";
import { mergeWorkspace, setOneWorkspaceForTests, type TwinWork } from "@/lib/one-workspace";
import { BOTS_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { ElsewhereCard, elsewhereOnMap, OneWorkspaceStatus, OtherSideRows, OwnHomeBadge, ownSectionName, TwinCopyLine, TwinWorkLine } from "./OneWorkspace";

const bot = (id: string, extra: Partial<RosterBot> = {}): RosterBot => ({ id, threadId: `t-${id}`, name: id[0]!.toUpperCase() + id.slice(1), title: "", color: "blue", avatarUrl: null, unread: false, ...extra });
const view = (other: Partial<SideRoster> = {}, extra: Partial<OneWorkspaceView> = {}): OneWorkspaceView => ({
  page: "computer", twinHome: "computer", cloudName: "My Cloud", other: { side: "cloud", state: "ready", at: 1, bots: [], rooms: [], sections: [], ...other }, ...extra,
});
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

afterEach(() => setOneWorkspaceForTests(null));

describe("the other side's rows in the sidebar", () => {
  it("open there, carry their home, and show unread and work only while that side answers", () => {
    const ready = mergeWorkspace(view({ bots: [bot("atlas", { unread: true, title: "Inbox" }), bot("kit", { section: "Ops", busy: true })] }), { bots: [], groups: [] });
    const html = render(createElement(OtherSideRows, { merged: ready, sectionId: BOTS_SECTION_ID, density: "comfortable", place: "after" }));
    expect(html).toContain('data-other-side-bot="atlas"');
    expect(html).toContain('data-home="cloud"');
    expect(html).toContain('aria-label="Open Atlas on My Cloud · On My Cloud · Unread"');
    // A Cloud bot's line says where it lives, in place of its title.
    expect(html).toContain(">On My Cloud<");
    expect(html).not.toContain("Inbox");
    expect(html).toContain('data-home-badge="cloud"');
    expect(html).toContain("bg-accent text-white");
    expect(html).not.toContain("kit");
    expect(render(createElement(OtherSideRows, { merged: ready, sectionId: userSectionId("Ops"), density: "comfortable", place: "after" }))).toContain('data-other-side-bot="kit"');

    const asleep = mergeWorkspace(view({ state: "asleep", bots: [bot("atlas", { unread: true })] }), { bots: [], groups: [] });
    const sleeping = render(createElement(OtherSideRows, { merged: asleep, sectionId: BOTS_SECTION_ID, density: "comfortable", place: "after" }));
    expect(sleeping).toContain('data-other-side-bot="atlas"');
    expect(sleeping).toContain("On My Cloud · asleep");
    expect(sleeping).not.toContain("Unread");
    expect(sleeping).not.toContain("size-2 shrink-0 rounded-full bg-accent");
  });

  it("say on My Cloud's page that they open on this computer, with no extra line for this computer's bots", () => {
    const merged = mergeWorkspace(view({ side: "computer", bots: [bot("ember"), bot("juno", { title: "Writes the notes" })] }, { page: "cloud" }), { bots: [], groups: [] });
    const html = render(createElement(OtherSideRows, { merged, sectionId: BOTS_SECTION_ID, density: "icons", place: "before" }));
    expect(html).toContain('aria-label="Open Ember on this computer · On this computer"');
    expect(html).toContain('data-home-badge="computer"');
    expect(html).toContain("bg-ink text-app");
    const rows = render(createElement(OtherSideRows, { merged, sectionId: BOTS_SECTION_ID, density: "comfortable", place: "before" }));
    expect(rows).not.toContain(">On this computer<");
    expect(rows).toContain("Writes the notes");
  });

  it("render nothing while the two are shown apart", () => {
    expect(render(createElement(OtherSideRows, { merged: null, sectionId: BOTS_SECTION_ID, density: "comfortable", place: "after" }))).toBe("");
  });
});

describe("this page's own rows", () => {
  it("get a home badge only while the two show together, and say when the other side has a copy", () => {
    expect(render(createElement(OwnHomeBadge, { id: "ember" }))).toBe("");
    setOneWorkspaceForTests({ view: view({ bots: [bot("ember")] }) });
    expect(render(createElement(OwnHomeBadge, { id: "ember" }))).toContain('aria-label="On this computer · also on My Cloud"');
    expect(render(createElement(OwnHomeBadge, { id: "juno" }))).toContain('aria-label="On this computer"');
    setOneWorkspaceForTests({ view: view({ side: "computer" }, { page: "cloud", cloudName: "Amit's Cloud" }) });
    expect(render(createElement(OwnHomeBadge, { id: "atlas", inline: true }))).toContain("On Amit&#x27;s Cloud");
    expect(render(createElement(OwnHomeBadge, { id: "atlas" }))).toContain("-bottom-1");
    expect(render(createElement(OwnHomeBadge, { id: "atlas", corner: "top" }))).toContain("-top-1");
  });

  it("keep their team menu only for teams this page has", () => {
    const merged = mergeWorkspace(view({ bots: [bot("kit", { section: "Ops" })] }), { bots: [{ id: "ember", section: "Research" }], groups: [], sections: ["Research"] });
    const one = { merged, searched: merged, needs: { bots: false, channels: false } };
    expect(ownSectionName(one, userSectionId("Research"))).toBe("Research");
    expect(ownSectionName(one, userSectionId("Ops"))).toBeNull();
    expect(ownSectionName(null, userSectionId("Ops"))).toBe("Ops");
    expect(ownSectionName(one, BOTS_SECTION_ID)).toBeNull();
  });
});

describe("the status line", () => {
  it("says plainly when My Cloud sleeps, can't be reached or needs a sign-in, and nothing while it answers", () => {
    const merged = (other: Partial<SideRoster>, page: "computer" | "cloud" = "computer") => mergeWorkspace(view(other, { page }), { bots: [], groups: [] });
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({}), density: "comfortable" }))).toBe("");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "asleep" }), density: "comfortable" }))).toContain("My Cloud is asleep. Opening one of its bots wakes it.");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "unreachable" }), density: "comfortable" }))).toContain("Can&#x27;t reach My Cloud right now.");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "unreachable", reason: "The server My Cloud runs on is being restarted." }), density: "comfortable" }))).toContain("being restarted");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "signed-out" }), density: "comfortable" }))).toContain("needs you to sign in again");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ side: "computer", state: "unreachable" }, "cloud"), density: "comfortable" }))).toContain("This computer isn&#x27;t answering.");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "asleep" }), density: "icons" }))).toBe("");
  });

  it("shows an open on its way, and why one was refused", () => {
    const merged = mergeWorkspace(view({}), { bots: [], groups: [] });
    setOneWorkspaceForTests({ opening: { side: "cloud", id: "atlas" } });
    expect(render(createElement(OneWorkspaceStatus, { merged, density: "comfortable" }))).toContain("Opening on My Cloud…");
    setOneWorkspaceForTests({ error: "My Cloud is not ready to connect yet." });
    const refused = render(createElement(OneWorkspaceStatus, { merged, density: "comfortable" }));
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("My Cloud is not ready to connect yet.");
  });
});

describe("the other side on the Team map", () => {
  it("draws its bots as cards that open there, with their computers, and nothing stale while it sleeps", () => {
    const merged = mergeWorkspace(view({ bots: [bot("atlas", { computer: "cloud", busy: true, unread: true }), bot("kit", { computer: "local" }), bot("vm", { computer: "vm" })] }), { bots: [], groups: [] });
    const map = elsewhereOnMap(merged)!;
    expect([...map.ids]).toEqual(["atlas", "kit", "vm"]);
    expect(map.computers.map((computer) => [computer.id, computer.state, computer.frame])).toEqual([["atlas", "working", undefined], ["vm", "idle", undefined]]);
    const card = render(createElement(ElsewhereCard, { bot: map.bots[0]!, merged }));
    expect(card).toContain('data-elsewhere-card="atlas"');
    expect(card).toContain("Open Atlas on My Cloud");
    expect(card).not.toContain("data-bot-id");

    const asleep = elsewhereOnMap(mergeWorkspace(view({ state: "asleep", bots: [bot("atlas", { computer: "cloud", busy: true, unread: true })] }), { bots: [], groups: [] }))!;
    expect(asleep.computers[0]!.state).toBe("asleep");
    expect([asleep.bots[0]!.busy, asleep.bots[0]!.unread]).toEqual([false, false]);
    expect(render(createElement(ElsewhereCard, { bot: asleep.bots[0]!, merged: asleep.merged }))).toContain("asleep");
    expect(elsewhereOnMap(null)).toBeNull();
  });
});

describe("a bot both sides have", () => {
  it("shows one row; a line under it opens what its copy out of sight has of its own", () => {
    const fromComputer = mergeWorkspace(view({ bots: [bot("ember", { threads: ["phone-1", "t-ember"], unreadThreads: ["phone-1"], automations: 1 })] }),
      { bots: [{ id: "ember", threadId: "t-ember", tasks: [{ threadId: "t-ember" }] }], groups: [] });
    expect(fromComputer.bots).toEqual([]);
    const line = render(createElement(TwinWorkLine, { work: fromComputer.twinWork.get("ember")!, cloudName: "My Cloud", density: "comfortable", onOpen: () => {} }));
    expect(line).toContain('data-twin-work="cloud"');
    expect(line).toContain("Also on My Cloud: 1 chat and 1 automation");
    expect(line).toContain('aria-label="Unread"');
    expect(render(createElement(TwinWorkLine, { work: fromComputer.twinWork.get("ember")!, cloudName: "My Cloud", density: "icons", onOpen: () => {} }))).toBe("");
    expect(render(createElement(TwinWorkLine, { work: { side: "computer", chats: 3, unshared: 0, unread: false, automations: 0 }, cloudName: "My Cloud", density: "comfortable", onOpen: () => {} })))
      .toContain("Also on this computer: 3 chats");
  });
});

describe("the line under a bot on both sides, and the line above its copy's chat", () => {
  it("lists what the copy out of sight has: its own chats, messages only it has in chats both have, its automations", () => {
    const line = (work: Partial<TwinWork>) => render(createElement(TwinWorkLine, { work: { side: "cloud", chats: 0, unshared: 0, unread: false, automations: 0, ...work }, cloudName: "My Cloud", density: "comfortable", onOpen: () => {} }));
    expect(line({ unshared: 2 })).toContain("Also on My Cloud: 2 messages only there");
    expect(line({ unshared: 1 })).toContain("Also on My Cloud: 1 message only there");
    expect(line({ chats: 1, unshared: 2, automations: 1 })).toContain("Also on My Cloud: 1 chat, 2 messages only there and 1 automation");
  });

  it("says above a copy's chat whose copy it is and where the chat is, only for a bot whose home is the other side", () => {
    const fromCloud = view({ side: "computer", bots: [bot("scout", { threads: ["t-scout"] })] }, { page: "cloud" });
    setOneWorkspaceForTests({ view: fromCloud });
    const copy = render(createElement(TwinCopyLine, { bot: { id: "scout", name: "Scout", threadId: "t-scout" } }));
    expect(copy).toContain('data-twin-copy="computer"');
    expect(copy).toContain("This is Scout&#x27;s copy on My Cloud, for routines while this computer is off. Your chat with Scout is on this computer.");
    expect(render(createElement(TwinCopyLine, { bot: { id: "clover", name: "Clover", threadId: "t" } }))).toBe("");
    setOneWorkspaceForTests({ view: view({ bots: [bot("scout")] }) });
    expect(render(createElement(TwinCopyLine, { bot: { id: "scout", name: "Scout", threadId: "t-scout" } }))).toBe("");
    setOneWorkspaceForTests({ view: view({ bots: [bot("scout")] }, { twinHome: "cloud" }) });
    expect(render(createElement(TwinCopyLine, { bot: { id: "scout", name: "Scout", threadId: "t-scout" } }))).toContain("This is Scout&#x27;s copy on this computer. Your chat with Scout is on My Cloud.");
  });
});
