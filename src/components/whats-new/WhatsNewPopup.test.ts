// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { WhatsNewAction, WhatsNewSlide, WhatsNewView } from "@/lib/whats-new";

const { WhatsNewPopup } = await import("./WhatsNewPopup");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const BOTH: WhatsNewView = { slides: ["pro", "team"], audience: "none", signedIn: true, staging: false,
  plans: { pro: { name: "Pro", terms: "Pro · $49/month + tax · 14-day money-back" }, team: { name: "Team", terms: "Free for 3 days, then $40/month + tax" } } };
const TEAM_ONLY: WhatsNewView = { ...BOTH, slides: ["team"], audience: "own", plans: { team: BOTH.plans.team } };
const PRO = "Meet the new MausBot Cloud", TEAM = "Shared bots for your whole team";

let host: HTMLDivElement, root: Root, opener: HTMLButtonElement;
let steps: Array<[WhatsNewAction, WhatsNewSlide]>;
const props = { report: vi.fn((action: WhatsNewAction, slide: WhatsNewSlide) => void steps.push([action, slide])), onBuy: vi.fn(), onOpenApps: vi.fn(), onDone: vi.fn() };
const NEWS: WhatsNewView = { ...BOTH, slides: ["apps", "publish", "cloudNews", "teamNews"], audience: "other", plans: {}, apps: { place: "computer", install: true } };
const APPS = "Your apps have a home", PUBLISH = "Publish your bots", CLOUD_NEWS = "What's new in MausBot Cloud", TEAM_NEWS = "What's new for your team";
const show = async (view: WhatsNewView = BOTH) => { await act(async () => { root.render(createElement(WhatsNewPopup, { view, ...props })); }); };
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!;
const title = () => document.getElementById(dialog().getAttribute("aria-labelledby")!)!.textContent;
const live = () => host.querySelector<HTMLElement>("[data-whats-new-slide]:not([inert])")!;
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
  .find(item => !item.closest("[inert]") && (item.textContent === name || item.getAttribute("aria-label") === name));
const click = async (name: string) => { const found = button(name); expect(found, name).toBeTruthy(); await act(async () => { found!.click(); }); };
const key = async (name: string, shiftKey = false) => {
  const event = new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(event); });
  return event;
};
const focused = () => (document.activeElement as HTMLElement).textContent || document.activeElement!.getAttribute("aria-label");
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  setLocale("en"); vi.clearAllMocks(); steps = [];
  opener = document.body.appendChild(document.createElement("button")); opener.textContent = "composer"; opener.focus();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  (window as { ogb?: unknown }).ogb = { openExternal: vi.fn(async () => true) };
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren(); delete (window as { ogb?: unknown }).ogb;
  document.documentElement.style.removeProperty("--code-color-scheme");
  delete document.documentElement.dataset.reducedMotion;
});

describe("the What's new popup", () => {
  it("is a labelled modal dialog that opens at its first slide's title, keeps Tab inside and gives focus back when it goes", async () => {
    await show();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(title()).toBe(PRO);
    expect(document.activeElement!.textContent).toBe(PRO);
    expect(live().getAttribute("aria-label")).toBe("Slide 1 of 2");
    const order: Array<string | null> = [];
    for (let i = 0; i < 8; i++) { expect((await key("Tab")).defaultPrevented).toBe(true); order.push(focused()); }
    expect(order, "the hidden slide's button is never reached").toEqual(["Get Pro", "See the new Cloud", "Not now", "Slide 1 of 2", "Slide 2 of 2", "Next", "Close", "Get Pro"]);
    await key("Tab", true); expect(focused()).toBe("Close");
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it("the first slide: My Cloud drawn, the new Cloud's words and price with no trial, Get Pro and See the new Cloud", async () => {
    await show();
    const slide = live();
    expect(slide.textContent).toContain("Your bots keep working when this computer is off. The new Cloud website puts your Clouds, team, billing and usage in one place.");
    expect(slide.textContent).toContain("Pro · $49/month + tax · 14-day money-back");
    expect(slide.textContent).not.toMatch(/trial/i);
    expect(slide.querySelector('[data-whats-new-picture="pro"]')!.textContent).toBe("My Cloud");
    expect(host.querySelectorAll("video"), "no plans clip on the Cloud slide").toHaveLength(0);
    expect(host.querySelector('[data-whats-new-picture="team"] img')!.getAttribute("src"), "the others show their still").toMatch(/team-dark\.webp/);
    expect([...slide.querySelectorAll("button")].map(item => item.textContent)).toEqual(["Get Pro", "See the new Cloud"]);
  });

  it("the slide on screen plays its loop: muted, looping, inline, the dark one on a dark skin", async () => {
    await show();
    await click("Next");
    const clip = live().querySelector("video")!;
    expect(clip.getAttribute("src")).toMatch(/team-dark\.mp4/);
    expect(clip.getAttribute("poster")).toMatch(/team-dark\.webp/);
    for (const flag of ["autoplay", "loop", "playsinline"]) expect(clip.hasAttribute(flag), flag).toBe(true);
    expect(clip.muted).toBe(true);
    expect(host.querySelectorAll("video"), "only the slide on screen plays").toHaveLength(1);
  });

  it("a light skin gets the light loops; reduced motion gets each slide's still, never a video", async () => {
    document.documentElement.style.setProperty("--code-color-scheme", "light");
    await show();
    await click("Next");
    expect(live().querySelector("video")!.getAttribute("src")).toMatch(/team-light\.mp4/);
    await act(async () => root.render(null));
    document.documentElement.dataset.reducedMotion = "true";
    await show();
    await click("Next");
    expect(host.querySelector("video")).toBeNull();
    expect(live().querySelector("img")!.getAttribute("src")).toMatch(/team-light\.webp/);
  });

  it("Next, Back, the dots and the arrow keys move between the slides; each slide is counted seen once, and each move from where it was", async () => {
    await show();
    expect(steps).toEqual([["seen", "pro"]]);
    await click("Next");
    expect(title()).toBe(TEAM); expect(document.activeElement!.textContent).toBe(TEAM);
    expect(live().getAttribute("aria-label")).toBe("Slide 2 of 2");
    expect(button("Next"), "no Next on the last slide").toBeUndefined();
    expect(button("Slide 2 of 2")!.getAttribute("aria-current")).toBe("true");
    await click("Back");
    expect(title()).toBe(PRO);
    expect(button("Back"), "no Back on the first slide").toBeUndefined();
    await click("Slide 2 of 2");
    expect(title()).toBe(TEAM);
    await key("ArrowLeft"); expect(title()).toBe(PRO);
    await key("ArrowLeft"); expect(title(), "nothing before the first").toBe(PRO);
    await key("ArrowRight"); expect(title()).toBe(TEAM);
    await key("ArrowRight"); expect(title(), "nothing after the last").toBe(TEAM);
    expect(steps).toEqual([["seen", "pro"], ["next", "pro"], ["seen", "team"], ["back", "team"], ["next", "pro"], ["back", "team"], ["next", "pro"]]);
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it("the Team slide: shared bots first, each person's own MausBot as their inbox, what the team shares, its loop and Start a Team", async () => {
    await show(TEAM_ONLY);
    const slide = live();
    expect(title()).toBe(TEAM);
    expect(slide.textContent).toContain("Everyone chats with the same bots, like one Support bot and one Sales bot, and hands them work. Each person's own MausBot is their inbox: anything for them lands there.");
    for (const point of ["Connected apps, set up once for everyone", "Group chats with teammates and bots together", "Team memory the bots share",
      "Bots hand work to each other across the team", "Choose who can use each bot"]) expect(slide.textContent).toContain(point);
    expect(slide.textContent).toContain("Free for 3 days, then $40/month + tax");
    expect(slide.querySelector("video")!.getAttribute("aria-label")).toBe("A team's group chat in MausBot: messages from people and bots, each with its replies.");
    expect([...slide.querySelectorAll("button")].map(item => item.textContent)).toEqual(["Start a Team"]);
    expect(button("Next")).toBeUndefined(); expect(button("Back")).toBeUndefined(); expect(button("Slide 1 of 1"), "one slide has no dots").toBeUndefined();
    expect(steps).toEqual([["seen", "team"]]);
  });

  it("Get Pro opens the buy flow; See the new Cloud and Start a Team open the Cloud website with the slide's tag; each ends it", async () => {
    await show();
    await click("Get Pro");
    expect(props.onBuy).toHaveBeenCalledExactlyOnceWith("pro"); expect(props.onDone).toHaveBeenCalledOnce();
    expect(steps.at(-1)).toEqual(["get_pro", "pro"]);
    expect(window.ogb!.openExternal, "Get Pro stays in the app").not.toHaveBeenCalled();

    vi.clearAllMocks(); await show();
    await click("See the new Cloud"); await flush();
    expect(window.ogb!.openExternal).toHaveBeenCalledWith("https://cloud.openmausbot.com/cloud?src=app_whats_new_pro");
    expect(props.onDone).toHaveBeenCalledOnce(); expect(steps.at(-1)).toEqual(["see_cloud", "pro"]);

    vi.clearAllMocks(); await show(); await click("Next");
    await click("Start a Team"); await flush();
    expect(window.ogb!.openExternal).toHaveBeenCalledWith("https://cloud.openmausbot.com/pro/buy?plan=team&src=app_whats_new_team");
    expect(props.onDone).toHaveBeenCalledOnce(); expect(steps.at(-1)).toEqual(["start_team", "team"]);
    expect(props.onBuy).not.toHaveBeenCalled();
  });

  it("someone with a plan of their own starts a Team in the app's own Add a Cloud, never the website's Get Team, which would only tell them to write in", async () => {
    await show(TEAM_ONLY);
    await click("Start a Team"); await flush();
    expect(props.onBuy).toHaveBeenCalledExactlyOnceWith("team"); expect(props.onDone).toHaveBeenCalledOnce();
    expect(window.ogb!.openExternal).not.toHaveBeenCalled();
    expect(steps.at(-1)).toEqual(["start_team", "team"]);
  });

  it("an app on the staging Admin opens the staging Cloud website", async () => {
    await show({ ...BOTH, staging: true }); await click("Next");
    await click("Start a Team"); await flush();
    expect(window.ogb!.openExternal).toHaveBeenCalledWith("https://omb-cloud-staging.fly.dev/pro/buy?plan=team&src=app_whats_new_team");
  });

  it("a browser that won't open keeps it up and says so", async () => {
    vi.mocked(window.ogb!.openExternal!).mockRejectedValueOnce(new Error("no browser"));
    await show();
    await click("See the new Cloud"); await flush();
    expect(props.onDone).not.toHaveBeenCalled();
    expect(live().textContent).toContain("Could not open your browser. Please try again.");
  });

  it("Not now, the X, Escape and a click outside end it, each counted on the slide it was on; a click inside does not", async () => {
    await show();
    await click("Next");
    await click("Not now");
    expect(steps.at(-1)).toEqual(["not_now", "team"]);
    for (const how of ["Close", "Escape", "outside", "inside"] as const) {
      vi.clearAllMocks(); steps = []; await act(async () => root.render(null)); await show();
      if (how === "Escape") expect((await key("Escape")).defaultPrevented).toBe(true);
      else if (how === "outside") await act(async () => { host.firstElementChild!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
      else if (how === "inside") await act(async () => { dialog().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
      else await click(how);
      if (how === "inside") { expect(props.onDone, how).not.toHaveBeenCalled(); continue; }
      expect(props.onDone, how).toHaveBeenCalledOnce(); expect(steps.at(-1), how).toEqual(["close", "pro"]);
    }
  });

  it("an Escape or an arrow key meant for something else leaves it alone", async () => {
    await show();
    const other = document.body.appendChild(document.createElement("input"));
    other.focus();
    expect((await key("Escape")).defaultPrevented).toBe(false);
    await key("ArrowRight");
    expect(title()).toBe(PRO); expect(props.onDone).not.toHaveBeenCalled();
  });

  it("Apps: where the apps are, by the screen's and section's own names, the apps screen's loop in either skin, and Open apps", async () => {
    await show(NEWS);
    const slide = live();
    expect(title()).toBe(APPS); expect(live().getAttribute("aria-label")).toBe("Slide 1 of 4");
    expect(slide.textContent).toContain("The apps your bots build now live in “Published apps”, under “On this computer”. Save any page a bot makes as an app, open it in its own window and install it on your computer.");
    const clip = slide.querySelector("video")!;
    expect(clip.getAttribute("src")).toMatch(/apps-dark\.mp4/); expect(clip.getAttribute("poster")).toMatch(/apps-dark\.webp/);
    expect(clip.getAttribute("aria-label")).toBe("Published apps: the apps your bots built, each as a card; the pointer opens one.");
    expect(button("Not now"), "Apps has a button of its own, and Not now").toBeTruthy();
    await click("Open apps");
    expect(props.onOpenApps).toHaveBeenCalledOnce(); expect(props.onDone).toHaveBeenCalledOnce(); expect(steps.at(-1)).toEqual(["open_apps", "apps"]);

    await act(async () => root.render(null));
    document.documentElement.style.setProperty("--code-color-scheme", "light");
    await show({ ...NEWS, apps: { place: "cloud", install: false } });
    expect(live().querySelector("video")!.getAttribute("src"), "filmed in the dark look only").toMatch(/apps-dark\.mp4/);
    expect(live().textContent, "a page that can't install apps or open their windows says only what it can")
      .toContain("The apps your bots build now live in “Published apps”, under “In this Cloud”. Save any page a bot makes as an app and open it there any time.");
  });

  it("Publish your bots names the menu item and the card's button; it and the slides that only tell offer no Not now, and only the last ends with Got it", async () => {
    await show(NEWS);
    await click("Next");
    const slide = live();
    expect(title()).toBe(PUBLISH);
    expect(slide.textContent).toContain("Share a bot as a template others can add to their own MausBot. Choose “Publish” in the bot's ⋯ menu, then “Publish to community”.");
    expect(slide.querySelector('[data-whats-new-picture="publish"]')!.textContent, "the menu drawn from the app's own labels").toContain("Publish");
    expect(slide.querySelector("video"), "a drawn picture, no clip").toBeNull();
    expect([...slide.querySelectorAll("button")]).toHaveLength(0);
    expect(button("Not now")).toBeUndefined(); expect(button("Got it")).toBeUndefined();
    await click("Next");
    expect(title()).toBe(CLOUD_NEWS);
    expect(live().querySelector("video"), "this slide draws My Cloud").toBeNull();
    expect(live().querySelector('[data-whats-new-picture="cloudNews"]')!.textContent).toBe("My Cloud");
    expect(button("Not now")).toBeUndefined(); expect(button("Got it")).toBeUndefined();
    await click("Next");
    expect(title()).toBe(TEAM_NEWS);
    expect(button("Not now")).toBeUndefined();
    await click("Got it");
    expect(props.onDone).toHaveBeenCalledOnce(); expect(steps.at(-1)).toEqual(["got_it", "teamNews"]);
    expect(props.onOpenApps).not.toHaveBeenCalled();
  });

  it("a Team Cloud's Owner or Admin: Invite your team opens the team's People page", async () => {
    const url = "https://cloud.openmausbot.com/team/t1/people?invite=1";
    await show({ ...BOTH, slides: ["team"], plans: {}, team: { kind: "invite", url } });
    expect([...live().querySelectorAll("button")].map(item => item.textContent)).toEqual(["Invite your team"]);
    await click("Invite your team"); await flush();
    expect(window.ogb!.openExternal).toHaveBeenCalledWith(url);
    expect(props.onDone).toHaveBeenCalledOnce(); expect(steps.at(-1)).toEqual(["invite", "team"]);
    expect(props.onBuy).not.toHaveBeenCalled();
  });

  it("a page that sells no plan starts a Team on the website, even for an audience it can't tell", async () => {
    await show({ ...BOTH, slides: ["team"], audience: "other", plans: { team: { name: "Team", terms: "$40 a month for 2 people, $20 for each extra person." } }, team: { kind: "start", inApp: false } });
    expect(live().textContent).toContain("$40 a month for 2 people, $20 for each extra person.");
    await click("Start a Team"); await flush();
    expect(window.ogb!.openExternal).toHaveBeenCalledWith("https://cloud.openmausbot.com/pro/buy?plan=team&src=app_whats_new_team");
  });
});
