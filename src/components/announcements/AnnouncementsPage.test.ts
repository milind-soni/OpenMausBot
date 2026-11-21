// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announcementHistory, type HistoryFacts } from "@/lib/announcement-history";
import { setLocale } from "@/lib/i18n";
import { TEAMS_NOTICE } from "@/lib/notices";
import type { AnnouncementCard } from "../../../shared/announcements";
import type { ReleaseEntry } from "../../../shared/release-notes";
import type { UpdaterState } from "@/lib/updater";
import type { Announcements } from "./use-announcements";

const f = vi.hoisted(() => ({ found: null as unknown as Announcements, dispatch: vi.fn(), state: { config: {} as Record<string, unknown> }, remembered: vi.fn() }));
vi.mock("./use-announcements", () => ({ useAnnouncements: () => f.found }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("../lazy-screens", () => ({ GrokMoveDialog: () => createElement("div", { "data-grok-move-dialog": "" }) }));
vi.mock("@/lib/announcement-history", async original => ({ ...await original<typeof import("@/lib/announcement-history")>(), rememberNoticeSeen: f.remembered }));
const { AnnouncementsPage } = await import("./AnnouncementsPage");
const { track } = await import("@/lib/analytics");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse("2026-11-18T10:00:00Z");
const browser: HistoryFacts = { branded: false, organization: false, cloudSale: false, cloudCards: false, remote: false, team: false, canSave: true, sponsors: true, modelgo: true };
const desktop: HistoryFacts = { ...browser, cloudSale: true, cloudCards: true };
const card: AnnouncementCard = { id: "phone-app-2026-11", kind: "product", title: { en: "MausBot on your phone", "pt-br": "MausBot no seu celular" }, body: "Chat with your bots anywhere.",
  primary: { label: "Open", action: { open: "my_cloud" } }, starts: "2026-11-20T00:00:00Z", ends: "2027-01-01T00:00:00Z" } as AnnouncementCard;
const markRead = vi.fn();
const found = (facts: HistoryFacts, extra: Partial<Announcements> = {}): Announcements => ({
  items: announcementHistory({ facts, cards: [card], feedUpdatedAt: null, now: NOW }), unread: false, markRead,
  person: { record: undefined, desktopSeen: [] }, writer: { team: false, saved: vi.fn() }, viewer: { hosted: false, canSave: true }, account: null, cloudBridge: false, branded: false, ...extra,
});

let host: HTMLDivElement, root: Root | null = null;
async function open() {
  root = createRoot(host);
  await act(async () => { root!.render(createElement(AnnouncementsPage)); });
  await act(async () => { await Promise.resolve(); });
}
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-announcement-item]")];
const click = async (element: Element | null | undefined) => { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); }); };

beforeEach(() => {
  setLocale("en"); vi.clearAllMocks(); f.state = { config: {} };
  host = document.createElement("div"); document.body.append(host);
  vi.stubGlobal("open", vi.fn());
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); vi.unstubAllGlobals(); delete (window as { ogb?: unknown }).ogb; });

describe("Announcements", () => {
  it("lists everything announced here, newest first, each with its date, words and buttons; an offer that ended says so", async () => {
    f.found = found(desktop);
    await open();
    expect(document.querySelector("h1")?.textContent).toBe("Announcements");
    expect(rows().map(row => row.dataset.announcementItem)).toEqual([card.id, TEAMS_NOTICE, "modelgo-offer-2026-11", "grok-move-2026-11", "whats-new-2026-11",
      "boat-credit-2026-11", "product-hunt-launch-2026-10", "cloud-trial-intro-v1"]);
    const teams = rows()[1]!;
    expect(teams.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-17T00:00:00.000Z");
    expect(teams.textContent).toContain("Nov 17, 2026");
    expect(teams.textContent).toContain("MausBot is better with your team");
    expect(teams.textContent).toContain("Show again");
    const hunt = rows().find(row => row.dataset.announcementItem === "product-hunt-launch-2026-10")!;
    expect(hunt.querySelector("[data-announcement-ended]")?.textContent).toBe("Ended");
    expect(hunt.querySelector("button"), "no button to an offer that is over").toBeNull();
    const boat = rows().find(row => row.dataset.announcementItem === "boat-credit-2026-11")!;
    expect([...boat.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Get Boat", "I bought it: claim my $50"]);
    expect(rows().find(row => row.dataset.announcementItem === "whats-new-2026-11")?.textContent, "the earlier What's new reopens only when it has something for this account")
      .not.toContain("Show again");
  });

  it("each button does what its own notice did", async () => {
    f.found = found(desktop);
    await open();
    const row = (id: string) => rows().find(each => each.dataset.announcementItem === id)!;
    await click([...row("modelgo-offer-2026-11").querySelectorAll("button")].find(button => button.textContent === "Get a ModelGo key"));
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining("modelgo"), "_blank", "noopener,noreferrer");
    await click(row("cloud-trial-intro-v1").querySelector("button"));
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_card" });
    await click(row(card.id).querySelector("button"));
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
  });

  it("opening it clears the red dot; with no dot there is nothing to write", async () => {
    f.found = found(browser);
    await open();
    expect(markRead).not.toHaveBeenCalled();
    await act(async () => root?.unmount()); root = null;
    f.found = found(browser, { unread: true });
    await open();
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("a popup's row opens the popup again, outside the notice queue; closing it marks it seen when it wasn't", async () => {
    f.found = found(browser);
    await open();
    await click(rows().find(row => row.dataset.announcementItem === TEAMS_NOTICE)?.querySelector("button"));
    const popup = document.querySelector("[data-teams-popup]");
    expect(popup?.getAttribute("data-teams-popup")).toBe("start");
    expect(track).toHaveBeenCalledWith("whats_new", { action: "seen", slide: "teams", audience: "no_team", campaign: TEAMS_NOTICE });
    await click([...popup!.querySelectorAll("button")].find(button => button.textContent === "Not now"));
    expect(document.querySelector("[data-teams-popup]")).toBeNull();
    expect(f.remembered).toHaveBeenCalledWith(TEAMS_NOTICE, undefined, expect.objectContaining({ team: false }));

    await click(rows().find(row => row.dataset.announcementItem === "grok-move-2026-11")?.querySelector("button"));
    await click(document.querySelector("[data-grok-move-popup] [data-primary]"));
    expect(document.querySelector("[data-grok-move-dialog]"), "Let's start opens the move, as from the popup").not.toBeNull();
  });

  it("on a Team Cloud: its admin's popup invites, a member's only tells; a member's list is Teams alone", async () => {
    f.state = { config: { team: { id: "team-acme", name: "Acme", cloudPage: "https://admin.openmausbot.com/cloud" } } };
    f.found = found({ ...browser, team: true, canSave: false, sponsors: false }, { viewer: { hosted: true, canSave: false, teamRole: "member" } });
    await open();
    expect(rows().map(row => row.dataset.announcementItem)).toEqual([card.id, TEAMS_NOTICE]);
    await click(rows()[1]!.querySelector("button"));
    expect(document.querySelector("[data-teams-popup]")?.getAttribute("data-teams-popup")).toBe("got-it");
    await act(async () => root?.unmount()); root = null;
    f.found = found({ ...browser, team: true }, { viewer: { hosted: true, canSave: true, teamRole: "admin" } });
    await open();
    await click(rows().find(row => row.dataset.announcementItem === TEAMS_NOTICE)?.querySelector("button"));
    expect(document.querySelector("[data-teams-popup]")?.getAttribute("data-teams-popup")).toBe("invite");
  });

  it("shows a card's words in the person's language", async () => {
    setLocale("pt-br");
    f.found = found(browser);
    await open();
    expect(rows()[0]!.textContent).toContain("MausBot no seu celular");
    expect(document.querySelector("h1")?.textContent).toBe("Anúncios");
  });

  describe("what each release brought", () => {
    const release = (version: string, date: string, items: string[] = ["**Faster start.** The app opens sooner.", "**Calmer sidebar,** with quieter rows.", "Third."]): ReleaseEntry =>
      ({ version, date, sections: [{ title: "Speed", items: items.slice(0, 2) }, { title: "Fixes", items: items.slice(2) }].filter(section => section.items.length) });
    const releases = [release("0.1.175", "2026-11-21T05:17:00Z"), release("0.1.173", "2026-11-19T23:52:37Z")];
    const install = vi.fn(async () => {});
    const desktopApp = (state: Partial<UpdaterState> | null) => {
      (window as { ogb?: unknown }).ogb = { app: { version: "0.1.173" }, updater: { onState: (listener: (next: UpdaterState) => void) => { if (state) listener(state as UpdaterState); return () => {}; }, install } };
    };
    const withReleases = (facts = browser, list = releases) => found(facts, { items: announcementHistory({ facts, cards: [card], feedUpdatedAt: null, now: NOW, releases: list }) });
    const row = (version: string) => document.querySelector<HTMLElement>(`[data-release="${version}"]`)!;

    it("one row per release in the same newest-first list: its date, What's new in its version, its first two leads; See all changes opens the rest", async () => {
      desktopApp({ status: "idle" });
      f.found = withReleases();
      await open();
      expect(rows().map(each => each.dataset.announcementItem).slice(0, 4)).toEqual(["release-0.1.175", card.id, "release-0.1.173", TEAMS_NOTICE]);
      const latest = row("0.1.175");
      expect(latest.querySelector("time")?.textContent).toBe("Nov 21, 2026");
      expect(latest.textContent).toContain("What's new in 0.1.175");
      expect(latest.textContent).toContain("Faster start. Calmer sidebar.");
      expect(latest.querySelector("[data-release-notes]")).toBeNull();
      expect(latest.querySelector("[data-release-restart]"), "nothing downloaded").toBeNull();
      const toggle = [...latest.querySelectorAll("button")].find(button => button.textContent === "See all changes")!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await click(toggle);
      const notes = latest.querySelector("[data-release-notes]")!;
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.textContent).toBe("Hide changes");
      expect([...notes.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual(["Speed", "Fixes"]);
      expect(notes.querySelector("li strong")?.textContent).toBe("Faster start.");
      expect(notes.querySelectorAll("li")).toHaveLength(3);
      expect(row("0.1.173").querySelector("[data-release-current]")?.textContent, "the version running here").toBe("You're on this version");
      expect(latest.querySelector("[data-release-current]")).toBeNull();
    });

    it("draws bold and code only: markup in a line stays words", async () => {
      desktopApp(null);
      f.found = withReleases(browser, [release("0.1.175", "2026-11-21T05:17:00Z", ["**Bold** `<img src=x onerror=alert(1)>` text"])]);
      await open();
      await click([...row("0.1.175").querySelectorAll("button")].find(button => button.textContent === "See all changes"));
      const line = row("0.1.175").querySelector("[data-release-notes] li")!;
      expect(line.querySelector("img")).toBeNull();
      expect(line.querySelector("code")?.textContent).toBe("<img src=x onerror=alert(1)>");
      expect(line.textContent).toBe("Bold <img src=x onerror=alert(1)> text");
    });

    it("Restart to update shows only on a downloaded update's row, and restarts as the update card does", async () => {
      desktopApp({ status: "downloading", version: "0.1.175", percent: 40 });
      f.found = withReleases();
      await open();
      expect(document.querySelector("[data-release-restart]")).toBeNull();
      await act(async () => root?.unmount()); root = null;
      desktopApp({ status: "downloaded", version: "0.1.175" });
      await open();
      const restart = row("0.1.175").querySelector<HTMLButtonElement>("[data-release-restart]")!;
      expect(restart.textContent).toBe("Restart to update");
      expect(document.querySelectorAll("[data-release-restart]")).toHaveLength(1);
      await click(restart);
      expect(install).toHaveBeenCalledTimes(1);
      expect(restart.disabled).toBe(true);
    });

    it("a downloaded update the list does not have yet gets a row on top from its own notes", async () => {
      desktopApp({ status: "downloaded", version: "v0.1.176", releaseNotes: "<h3>Chat</h3><ul><li><strong>Replies stream sooner.</strong> Yes.</li></ul>" });
      f.found = withReleases();
      await open();
      expect(rows()[0]!.dataset.announcementItem).toBe("release-0.1.176");
      expect(rows()[0]!.textContent).toContain("What's new in 0.1.176");
      expect(rows()[0]!.textContent).toContain("Replies stream sooner.");
      expect(rows()[0]!.querySelector("[data-release-restart]")).not.toBeNull();
    });

    it("a branded build shows no releases, not even a downloaded update", async () => {
      desktopApp({ status: "downloaded", version: "0.1.176" });
      f.found = { ...withReleases({ ...browser, branded: true }), branded: true };
      await open();
      expect(document.querySelector("[data-release]")).toBeNull();
    });
  });
});
