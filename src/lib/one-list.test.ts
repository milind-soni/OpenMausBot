import { beforeEach, describe, expect, it } from "vitest";
import type { Bot } from "@/state/store";
import { loadLocale, setLocale } from "./i18n";
import { arrangedEntries, deletedEntries, LANDING_SECTION, layOneList, placeDepartment, renamedEntries } from "./one-list";
import type { ArrangedBot } from "./places-together";

const bot = (id: string, over: Partial<Bot> = {}): Bot => ({ id, name: id, threadId: `${id}-t`, title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "here", model: "m" }, ...over });
const keyed = (place: string) => (b: Bot) => (b.id.includes(":") ? b.id : `${place}:${b.id}`);
/** The list as drawn: each department's name, then its bots by key. */
const drawn = (laid: { bots: Bot[]; sections: string[] }, keyOf: (b: Bot) => string) => ["", ...laid.sections].flatMap((section) => {
  const rows = laid.bots.filter((b) => (b.section ?? "") === section).map(keyOf);
  return section ? [`# ${section}`, ...rows] : rows;
});

beforeEach(() => setLocale("en"));

// This computer is home: Git Tasks outside any department, Ledger in Finance. My Cloud has Scout and Atlas.
const computer = [bot("git"), bot("ledger", { section: "Finance" })];
const cloud = [bot("scout"), bot("atlas")];
/** This computer's page: its own bots, and My Cloud's as rows. */
const onComputer = (arranged: ArrangedBot[], cloudBots = cloud) => {
  const keyOf = keyed("computer");
  return drawn(layOneList({ homeBots: computer, homeSections: ["Finance"], otherBots: cloudBots.map((b) => bot(`cloud:${b.id}`, b.section ? { section: b.section } : {})), arranged, keyOf, landing: placeDepartment("cloud") }), keyOf);
};
/** My Cloud's page: this computer's bots as rows (each saying its department there), and its own. */
const onCloud = (arranged: ArrangedBot[], cloudBots = cloud) => {
  const keyOf = keyed("cloud");
  return drawn(layOneList({ homeBots: computer.map((b) => bot(`computer:${b.id}`, b.section ? { section: b.section } : {})), homeSections: ["Finance"], otherBots: cloudBots, arranged, keyOf, landing: placeDepartment("cloud") }), keyOf);
};

describe("the one list's departments", () => {
  it("the other place's bots land in a department named after their place, after the home place's departments", () => {
    expect(onComputer([])).toEqual(["computer:git", "# Finance", "computer:ledger", "# My Cloud", "cloud:scout", "cloud:atlas"]);
    expect(placeDepartment("computer")).toBe("This computer");
  });

  it("their own department there does not count here: until moved, they are in their place's department", () => {
    expect(onComputer([], [bot("scout", { section: "Research" }), bot("atlas")])).toEqual(["computer:git", "# Finance", "computer:ledger", "# My Cloud", "cloud:scout", "cloud:atlas"]);
  });

  it("a bot dragged anywhere stays there, among the home place's bots too, in the order it was put", () => {
    const arranged: ArrangedBot[] = [
      { key: "cloud:atlas", section: "Finance", after: null },
      { key: "cloud:scout", section: "", after: "computer:git" },
    ];
    expect(onComputer(arranged)).toEqual(["computer:git", "cloud:scout", "# Finance", "cloud:atlas", "computer:ledger"]);
  });

  it("both pages draw the same list: the home place's departments and order, and the other place's bots where they were put", () => {
    for (const arranged of [[], [{ key: "cloud:atlas", section: "Finance", after: "computer:ledger" }, { key: "cloud:scout", section: "", after: null }]] as ArrangedBot[][]) {
      expect(onCloud(arranged)).toEqual(onComputer(arranged));
    }
  });

  it("a new bot of the other place lands in the place's department; a bot already placed is never pulled back there", () => {
    const arranged: ArrangedBot[] = [{ key: "cloud:scout", section: "Finance", after: null }];
    expect(onComputer(arranged, [...cloud, bot("nova")])).toEqual(["computer:git", "# Finance", "cloud:scout", "computer:ledger", "# My Cloud", "cloud:atlas", "cloud:nova"]);
  });

  it("a bot placed under one that left its department, or is gone, goes to the end of its department; a chain of moved bots keeps its order", () => {
    const arranged: ArrangedBot[] = [
      { key: "cloud:atlas", section: "", after: "cloud:scout" },
      { key: "cloud:scout", section: "", after: "computer:ledger" },
    ];
    expect(onComputer(arranged)).toEqual(["computer:git", "cloud:scout", "cloud:atlas", "# Finance", "computer:ledger"]);
    expect(onComputer([{ key: "cloud:scout", section: "", after: "cloud:gone" }])).toEqual(["computer:git", "cloud:scout", "# Finance", "computer:ledger", "# My Cloud", "cloud:atlas"]);
  });

  it("a pinned bot or a Chief outside any department stays where its own page draws it and is not laid out", () => {
    const keyOf = keyed("cloud");
    const laid = layOneList({ homeBots: [], homeSections: [], otherBots: [bot("maus", { chiefOfStaff: true }), bot("pin", { pinned: true }), bot("scout")], arranged: [], keyOf, landing: "My Cloud" });
    expect(laid.bots.map((b) => [b.id, b.section ?? ""])).toEqual([["maus", ""], ["pin", ""], ["scout", "My Cloud"]]);
  });

  it("pinned bots keep their own order across departments, as with the switch off", () => {
    const home = [bot("a", { section: "A" }), bot("p1", { pinned: true, section: "B" }), bot("p2", { pinned: true, section: "A" }), bot("p3", { pinned: true })];
    const laid = layOneList({ homeBots: home, homeSections: ["A", "B"], otherBots: [], arranged: [], keyOf: keyed("computer"), landing: "My Cloud" });
    expect(laid.bots.filter((b) => b.pinned).map((b) => b.id)).toEqual(["p1", "p2", "p3"]);
    expect(laid.bots.filter((b) => b.pinned).every((b, index) => b === home.filter((h) => h.pinned)[index])).toBe(true);
  });

  it("a row that did not move is the same value from one layout to the next, so it is not drawn again", () => {
    const rows = cloud.map((b) => bot(`cloud:${b.id}`));
    const lay = () => layOneList({ homeBots: computer, homeSections: ["Finance"], otherBots: rows, arranged: [], keyOf: keyed("computer"), landing: "My Cloud" }).bots;
    lay().forEach((b, index) => expect(b).toBe(lay()[index]));
  });
});

describe("what main keeps when bots move", () => {
  const keyOf = (id: string) => (id.includes(":") ? id : `computer:${id}`);
  const kept = (id: string) => id.includes(":");

  it("every bot main keeps in the list is written with the bot drawn just above it; this page's own bots are not", () => {
    expect(arrangedEntries("Finance", ["cloud:atlas", "ledger", "cloud:scout"], kept, keyOf)).toEqual([
      { key: "cloud:atlas", section: "Finance", after: null },
      { key: "cloud:scout", section: "Finance", after: "computer:ledger" },
    ]);
    expect(arrangedEntries("", ["git", "ledger"], kept, keyOf)).toEqual([]);
  });

  it("a deleted department sends its bots to the end of the list outside any department", () => {
    expect(deletedEntries(["cloud:atlas", "cloud:nova"], ["computer:git", "cloud:scout"])).toEqual([
      { key: "cloud:atlas", section: "", after: "cloud:scout" },
      { key: "cloud:nova", section: "", after: "cloud:atlas" },
    ]);
    expect(deletedEntries([], ["computer:git"])).toBeNull();
  });

  /** This computer's page laid out with `arranged`, as the sidebar holds it. */
  const laidOut = (arranged: ArrangedBot[], homeSections = ["Finance"]) => layOneList({ homeBots: computer, homeSections,
    otherBots: cloud.map((b) => bot(`cloud:${b.id}`)), arranged, keyOf: keyed("computer"), landing: "My Cloud" }).bots;

  it("renaming the place's department moves every Cloud bot drawn in it, also the ones only there by landing", () => {
    // No bot was ever moved: both are in "My Cloud" by landing, and both follow the rename.
    expect(renamedEntries(laidOut([]), "My Cloud", "Trips", kept, keyOf, "My Cloud")).toEqual([
      { key: "cloud:scout", section: "Trips", after: null },
      { key: "cloud:atlas", section: "Trips", after: "cloud:scout" },
    ]);
    // One was put there by hand, one landed: still both, in the order drawn, never split.
    const some: ArrangedBot[] = [{ key: "cloud:atlas", section: LANDING_SECTION, after: null }];
    expect(renamedEntries(laidOut(some), "My Cloud", "Trips", kept, keyOf, "My Cloud").map((entry) => [entry.key, entry.section])).toEqual([["cloud:atlas", "Trips"], ["cloud:scout", "Trips"]]);
    // Once "Trips" is made on this computer's server (the rename does that first), no bot is left behind in "My Cloud".
    const renamed = [...some, ...renamedEntries(laidOut(some), "My Cloud", "Trips", kept, keyOf, "My Cloud")];
    const keyOfBot = keyed("computer");
    expect(drawn(layOneList({ homeBots: computer, homeSections: ["Finance", "Trips"], otherBots: cloud.map((b) => bot(`cloud:${b.id}`)), arranged: renamed, keyOf: keyOfBot, landing: "My Cloud" }), keyOfBot))
      .toEqual(["computer:git", "# Finance", "computer:ledger", "# Trips", "cloud:atlas", "cloud:scout"]);
    expect(renamedEntries(laidOut([]), "Finance", "Money", kept, keyOf, "My Cloud")).toEqual([]);
  });
});

describe("departments that change elsewhere, and the language", () => {
  it("a Cloud bot kept in a department the home place no longer has goes back to the place's own department", () => {
    // "Trips" was renamed or deleted on the Team map, in another window or on a phone: no department of that name is drawn.
    expect(onComputer([{ key: "cloud:atlas", section: "Trips", after: null }])).toEqual(["computer:git", "# Finance", "computer:ledger", "# My Cloud", "cloud:scout", "cloud:atlas"]);
    expect(onCloud([{ key: "cloud:atlas", section: "Trips", after: null }])).toEqual(onComputer([{ key: "cloud:atlas", section: "Trips", after: null }]));
    // While the home place has it, the bot stays there.
    const keyOf = keyed("computer");
    expect(drawn(layOneList({ homeBots: computer, homeSections: ["Finance", "Trips"], otherBots: [bot("cloud:atlas")], arranged: [{ key: "cloud:atlas", section: "Trips", after: null }], keyOf, landing: "My Cloud" }), keyOf))
      .toEqual(["computer:git", "# Finance", "computer:ledger", "# Trips", "cloud:atlas"]);
  });

  it("the place's own department is kept as a mark, drawn in the person's language; one kept under its name before still reads as it", async () => {
    // Home is My Cloud: this computer's bots land in "This computer".
    const keyOf = keyed("cloud");
    const arranged: ArrangedBot[] = [{ key: "computer:git", section: LANDING_SECTION, after: null }, { key: "computer:ledger", section: "This computer", after: "computer:git" }];
    const lay = (landing: string) => drawn(layOneList({ homeBots: [], homeSections: [], otherBots: [bot("computer:ledger"), bot("computer:git")], arranged, keyOf, landing }), keyOf);
    expect(lay(placeDepartment("computer"))).toEqual(["# This computer", "computer:git", "computer:ledger"]);
    await loadLocale("pt-br");
    const there = placeDepartment("computer");
    expect(there).not.toBe("This computer");
    // Another language: the marked bot follows the name; the one kept as text goes back to the place's own department.
    expect(lay(there)).toEqual([`# ${there}`, "computer:git", "computer:ledger"]);
    expect(arrangedEntries(there, ["computer:git"], (id) => id.includes(":"), (id) => id, there)).toEqual([{ key: "computer:git", section: LANDING_SECTION, after: null }]);
  });
});
