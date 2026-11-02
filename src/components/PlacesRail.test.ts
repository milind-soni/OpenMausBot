// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RailPlace, RailState } from "../../electron/cloud-rail.mjs";
import { setLocale } from "@/lib/i18n";
import { placeInitials, refreshPlaces } from "@/lib/places";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./cloud-buy/CloudMascotScene", () => ({ CloudMascotScene: () => null }));
const { PlacesRail, matchingPlaces, placeLabel, shownPlaces } = await import("./PlacesRail");
const { DesktopWorkspaceSwitcher } = await import("./DesktopWorkspaceSwitcher");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const place = (id: string, name: string, extra: Partial<RailPlace> = {}): RailPlace => ({ id, name, color: null, kind: "cloud", opens: true, ...extra });
const PLACES: RailPlace[] = [
  place("home", "My Cloud", { color: "purple", active: true }),
  place("a", "Client A", { color: "teal" }),
  place("acme", "Acme", { kind: "team", attention: true }),
  place("pending:c-b", "Client B", { opens: false, progress: 0, waiting: true }),
  place("c", "Client C", { progress: 0.4 }),
  place("vps", "Office", { kind: "server" }),
];
let host: HTMLDivElement, root: Root | null = null;
let rail: RailState;
const workspaces = { state: vi.fn(async () => ({ local: false, name: "My Cloud" })), menu: vi.fn(async () => {}), places: vi.fn(async () => rail),
  open: vi.fn(async () => {}), add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined), onChanged: vi.fn(() => () => {}) };
type Organizations = { canAdd: boolean; blocked?: "no_team_plan" | "limit" | "rate" | "off"; count: number; max: number };
let organizations: Organizations | undefined;
const cloudAdd = { state: vi.fn(async () => ({ signedIn: true, hasCloud: true, supported: false, canAdd: false, offer: null, count: 1, home: { name: "My Cloud", color: null },
  ...(organizations ? { organizations } : {}) })),
  start: vi.fn(), reopen: vi.fn(), copyLink: vi.fn(), open: vi.fn(), interest: vi.fn(async () => {}), sheet: vi.fn(async () => {}),
  organization: vi.fn(async (): Promise<{ outcome: "added" | "taken" | "unsupported" | "failed" } | { outcome: "blocked"; blocked: "no_team_plan" | "limit" | "rate" | "off" }> => ({ outcome: "added" })) };
async function mount(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => { await refreshPlaces(); root!.render(element); });
  await act(async () => { await Promise.resolve(); });
}
const click = async (element: Element | null | undefined) => { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); }); };
beforeEach(() => {
  setLocale("en");
  rail = { places: PLACES, add: { cloud: true, link: true, address: false } };
  organizations = undefined;
  Object.assign(window, { ogb: { workspaces, cloudAdd } });
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); document.body.innerHTML = ""; });

it("a circle per place, with its initials on its colour; the place on screen is marked, one that needs the person has a dot, one being set up a ring", async () => {
  await mount(createElement(PlacesRail));
  const circles = [...host.querySelectorAll("[data-rail-place]")];
  expect(circles.map((circle) => circle.textContent)).toEqual(["MC", "CA", "A", "CB", "CC", "O"]);
  expect(host.querySelector('[data-rail-place="home"]')?.getAttribute("aria-current")).toBe("page");
  expect(host.querySelector('[data-rail-place="home"] span[style]')?.getAttribute("style")).toContain("var(--identity-purple)");
  expect(host.querySelector('[data-rail-place="acme"] [data-rail-dot]')).toBeTruthy();
  expect(host.querySelector('[data-rail-place="pending:c-b"] [data-rail-ring]')?.getAttribute("data-rail-ring")).toBe("waiting");
  expect(host.querySelector('[data-rail-place="c"] [data-rail-ring]')?.getAttribute("data-rail-ring")).toBe("40");
  expect(host.querySelector('[data-rail-place="c"]')?.getAttribute("aria-label")).toBe("Client C: setting up");
  expect(host.querySelector('[data-rail-place="pending:c-b"]')?.getAttribute("aria-label")).toBe("Client B: waiting for payment");
  expect(host.querySelector("[data-rail-more-button]")).toBeNull();
  expect(host.querySelector("[data-rail-add]")?.getAttribute("aria-label")).toBe("Add a Cloud or your own server");
});

it("marks the place on screen with a pill on the rail's edge, a short one on hover for a place that opens, and no ring round a tile", async () => {
  await mount(createElement(PlacesRail, { chrome: true }));
  const pill = (id: string) => host.querySelector(`[data-rail-place="${id}"] [data-rail-pill]`);
  expect(pill("home")?.getAttribute("data-rail-pill")).toBe("page");
  expect(pill("home")?.getAttribute("class")).toEqual(expect.stringContaining("h-4"));
  expect(pill("home")?.getAttribute("class"), "on the rail's left edge, outside the tile").toEqual(expect.stringContaining("-left-1.5"));
  expect(pill("a")?.getAttribute("data-rail-pill")).toBe("hover");
  expect(pill("a")?.getAttribute("class")).toEqual(expect.stringContaining("group-hover/tile:opacity-100"));
  expect(pill("pending:c-b"), "nothing to open yet: no pill").toBeNull();
  for (const tile of host.querySelectorAll("[data-rail-place]")) expect(tile.className, tile.getAttribute("data-rail-place")!).not.toMatch(/\bring-/);
  expect(host.querySelector('[data-rail-place="c"] [data-rail-ring] path')?.getAttribute("stroke-width"), "a whole-pixel line").toBe("2");
  expect(host.querySelector("[data-places-rail] ul")?.className, "as wide as the rail, so a list that scrolls cuts nothing off round a tile").toEqual(expect.stringContaining("w-full"));
});

it("a click opens the place through main by its id; the one on screen and one not ready yet open nothing", async () => {
  await mount(createElement(PlacesRail));
  await click(host.querySelector('[data-rail-place="a"]'));
  await click(host.querySelector('[data-rail-place="home"]'));
  await click(host.querySelector('[data-rail-place="pending:c-b"]'));
  expect(workspaces.open.mock.calls).toEqual([["a"]]);
});

it("one place or none, an older app, or a browser: no rail, and the switcher stays", async () => {
  rail = { places: [], add: { cloud: true, link: true, address: true } };
  await mount(createElement("div", null, createElement(PlacesRail), createElement(DesktopWorkspaceSwitcher, { inline: true })));
  expect(host.querySelector("[data-places-rail]")).toBeNull();
  expect(host.querySelector("[data-switcher-beside-rail]")).toBeNull();
  expect(host.querySelector('[data-workspace-switcher="inline"]')).toBeTruthy();
});

it("beside the rail, the switcher at the top of the sidebar steps aside on a wide window", async () => {
  await mount(createElement("div", null, createElement(PlacesRail), createElement(DesktopWorkspaceSwitcher, { inline: true })));
  expect(host.querySelector("[data-places-rail]")?.className).toContain("md:flex");
  expect(host.querySelector("[data-switcher-beside-rail]")?.className).toContain("md:hidden");
});

it("past eight places, ⋯ opens every place, searchable; the place on screen stays among the circles", async () => {
  const many = Array.from({ length: 11 }, (_, n) => place(`p${n}`, `Client ${String.fromCharCode(65 + n)}`, n === 9 ? { active: true } : {}));
  rail = { places: many, add: { cloud: true, link: true, address: false } };
  expect(shownPlaces(many).map((entry) => entry.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p9"]);
  expect(shownPlaces(PLACES)).toEqual(PLACES);
  await mount(createElement(PlacesRail));
  expect(host.querySelectorAll("[data-rail-place]")).toHaveLength(8);
  await click(host.querySelector("[data-rail-more-button]"));
  const list = host.querySelector("[data-rail-more]")!;
  expect(list.querySelectorAll("li")).toHaveLength(11);
  const input = list.querySelector("input")!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "client k");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect([...list.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["CKClient K"]);
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(workspaces.open.mock.calls).toEqual([["p10"]]);
  expect(matchingPlaces(many, "zzz")).toEqual([]);
});

const type = async (input: Element | null, value: string) => {
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async (form: Element | null) => {
  expect(form).toBeTruthy();
  await act(async () => { (form as HTMLFormElement).requestSubmit(); await Promise.resolve(); await Promise.resolve(); });
};

it("＋ offers buying a Cloud or adding the person's own server: a box to paste its pairing link, sent to main's own Connect dialog", async () => {
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  const sheet = document.querySelector("[data-place-add-sheet]")!;
  expect([...sheet.querySelectorAll("[data-place-add-choice]")].map((choice) => choice.getAttribute("data-place-add-choice"))).toEqual(["cloud", "server"]);
  await click(sheet.querySelector('[data-place-add-choice="server"]'));
  const form = document.querySelector('[data-place-add="own-server"]')!;
  expect(form.textContent).toContain("Paste pairing link");
  expect(form.textContent, "no install commands: the server's Settings shows its link").not.toContain("npx");
  expect(document.activeElement).toBe(form.querySelector("[data-own-server-link]"));
  const connect = [...form.querySelectorAll("button")].find((button) => button.textContent === "Connect")!;
  expect(connect.disabled, "nothing pasted yet").toBe(true);
  await type(form.querySelector("[data-own-server-link]"), "  https://bots.example.test/#pair=abc  ");
  await submit(form);
  expect(workspaces.add.mock.calls).toEqual([["link", "https://bots.example.test/#pair=abc"]]);
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
});

it("a pasted link main can't open says so and keeps the sheet; cancelling main's Connect keeps it too", async () => {
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await click(document.querySelector('[data-place-add-choice="server"]'));
  const form = document.querySelector('[data-place-add="own-server"]')!;
  await type(form.querySelector("[data-own-server-link]"), "not a link");
  workspaces.add.mockRejectedValueOnce(new Error("Enter an HTTPS server address or a full pairing link."));
  await submit(form);
  expect(form.querySelector('[role="alert"]')?.textContent).toContain("isn't a pairing link");
  expect(document.querySelector("[data-place-add-sheet]")).toBeTruthy();
  await type(form.querySelector("[data-own-server-link]"), "https://bots.example.test/#pair=abc");
  expect(form.querySelector('[role="alert"]'), "editing the link clears the error").toBeNull();
  workspaces.add.mockResolvedValueOnce(false);
  await submit(form);
  expect(document.querySelector("[data-place-add-sheet]"), "the person cancelled Connect").toBeTruthy();
});

const createButton = () => [...document.querySelectorAll<HTMLButtonElement>('[data-place-add="organization"] button[type="submit"]')][0];

it("＋ for the account a Team plan's organizations are billed to: New organization first; a name and a color add it at once, no checkout, and the sheet closes", async () => {
  rail = { places: PLACES, add: { cloud: true, link: true, address: false, organization: true } };
  organizations = { canAdd: true, count: 3, max: 10 };
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  const sheet = document.querySelector("[data-place-add-sheet]")!;
  expect([...sheet.querySelectorAll("[data-place-add-choice]")].map((choice) => choice.getAttribute("data-place-add-choice"))).toEqual(["organization", "cloud", "server"]);
  await click(sheet.querySelector('[data-place-add-choice="organization"]'));
  await act(async () => { await Promise.resolve(); });
  const form = document.querySelector('[data-place-add="organization"]')!;
  expect(form.querySelector("h2")?.textContent).toBe("New organization");
  expect(form.textContent).toContain("nothing to pay now");
  expect(form.querySelector("[data-org-count]")?.textContent).toBe("Organization 4 of 10");
  expect(createButton()?.disabled, "a name first").toBe(true);
  await type(form.querySelector("input"), "  Client   B ");
  expect(form.querySelector("[data-org-preview]")?.textContent).toBe("Client B");
  await click(form.querySelector("[data-swatch='violet']"));
  await click(createButton());
  await act(async () => { await Promise.resolve(); });
  expect(cloudAdd.organization.mock.calls).toEqual([["Client B", "violet"]]);
  expect(cloudAdd.start, "never a checkout").not.toHaveBeenCalled();
  expect(document.querySelector("[data-place-add-sheet]"), "added: the rail shows it being set up").toBeNull();
});

it("New organization says plainly why it can't be added: the plan has as many as it can, the name is taken, or it didn't work; nothing else is offered then", async () => {
  rail = { places: PLACES, add: { cloud: false, link: false, address: false, organization: true } };
  organizations = { canAdd: false, blocked: "limit", count: 10, max: 10 };
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await act(async () => { await Promise.resolve(); });
  const form = document.querySelector('[data-place-add="organization"]')!;
  expect(form, "the only choice opens at once").toBeTruthy();
  expect(form.querySelector("[data-org-problem]")?.textContent).toBe("Your Team plan has as many organizations as it can have. Email us to add more.");
  await type(form.querySelector("input"), "Client K");
  expect(createButton()?.disabled).toBe(true);
  // Closed for a reason this app doesn't know: the neutral word, not the limit.
  await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; host = document.createElement("div"); document.body.append(host);
  organizations = { canAdd: false, count: 2, max: 10 };
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await act(async () => { await Promise.resolve(); });
  expect(document.querySelector('[data-place-add="organization"] [data-org-problem]')?.textContent).toBe("New organizations aren't available right now.");
  await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; host = document.createElement("div"); document.body.append(host);
  organizations = { canAdd: true, count: 2, max: 10 };
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await act(async () => { await Promise.resolve(); });
  const again = document.querySelector('[data-place-add="organization"]')!;
  await type(again.querySelector("input"), "Client A");
  for (const [answer, said] of [
    [{ outcome: "taken" }, "Another of your organizations has that name. Choose another."],
    [{ outcome: "blocked", blocked: "rate" }, "Too many organizations were added just now. Try again in a few minutes."],
    [{ outcome: "unsupported" }, "Nothing was added. Try again in a moment."],
  ] as const) {
    cloudAdd.organization.mockResolvedValueOnce(answer);
    await click(createButton());
    await act(async () => { await Promise.resolve(); });
    expect(again.querySelector("[data-org-problem]")?.textContent).toBe(said);
  }
  cloudAdd.organization.mockRejectedValueOnce(new Error("main went away"));
  await click(createButton());
  await act(async () => { await Promise.resolve(); });
  expect(again.querySelector("[data-org-problem]")?.textContent).toBe("Nothing was added. Try again in a moment.");
  expect(document.querySelector("[data-place-add-sheet]"), "the sheet stays open to try again").toBeTruthy();
});

it("Buy a Cloud, for someone whose Admin sells one Cloud per account: the calm word, never an error", async () => {
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await click(document.querySelector('[data-place-add-choice="cloud"]'));
  await act(async () => { await Promise.resolve(); });
  const flow = document.querySelector('[data-cloud-add="extra-one"]')!;
  expect(flow.textContent).toContain("One Cloud per account for now");
  expect(flow.textContent).toContain("You have My Cloud.");
  expect(cloudAdd.sheet).toHaveBeenCalledWith(true);
});

it("a circle's letters and words", () => {
  expect(["Client A", "Acme", "  my  cloud ", "Ünïcode Øne", "😀 Fun"].map(placeInitials)).toEqual(["CA", "A", "MC", "ÜØ", "😀F"]);
  expect(placeLabel(place("local", "This computer", { kind: "computer" }))).toBe("This computer");
  expect(placeLabel(place("x", "Acme", { attention: true }))).toBe("Acme: needs you");
});

it("a server of the person's own that signed in: a small server mark, the offline look with when it was last seen, and nothing to open when only its own network reaches it", async () => {
  const now = Date.UTC(2026, 9, 28, 12);
  const servers = [
    place("home", "My Cloud", { active: true }),
    place("vps", "Office", { kind: "server", server: true }),
    place("signed-in:s-mini", "Mac mini", { kind: "server", opens: false, ownNetwork: true, server: true, offline: true, lastSeenAt: now - 2 * 3_600_000 }),
    place("signed-in:s-render", "Render VPS", { kind: "server", opens: false, pairs: true, server: true }),
  ];
  expect(placeLabel(servers[1]!)).toBe("Office, your own server");
  expect(placeLabel(servers[2]!, now)).toBe("Mac mini, your own server: offline, last seen 2 hours ago · Only reachable on its own network");
  expect(placeLabel({ ...servers[2]!, lastSeenAt: undefined, ownNetwork: undefined })).toBe("Mac mini, your own server: offline");
  expect(placeLabel(servers[3]!)).toBe("Render VPS, your own server: connect it to this app");
  expect(placeLabel(place("s", "Mac mini", { kind: "server", server: true, update: { version: "0.1.118", latest: "0.1.130" } })))
    .toBe("Mac mini, your own server · on 0.1.118, 0.1.130 is out");
  rail = { places: servers, add: { cloud: true, link: true, address: false } };
  await mount(createElement(PlacesRail));
  expect(host.querySelector('[data-rail-place="vps"] [data-rail-server]')).toBeTruthy();
  expect(host.querySelector("[data-rail-update]"), "no reminder without a newer release").toBeNull();
  expect(host.querySelector('[data-rail-place="home"] [data-rail-server]')).toBeNull();
  const mini = host.querySelector('[data-rail-place="signed-in:s-mini"]')!;
  expect(mini.querySelector("[data-rail-offline]")?.className).toContain("grayscale");
  expect(mini.getAttribute("aria-disabled")).toBe("true");
  expect(mini.getAttribute("title")).toContain("Only reachable on its own network");
  await click(mini);
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
  await click(host.querySelector('[data-rail-place="vps"]'));
  expect(workspaces.open.mock.calls, "one saved by hand opens as it always did").toEqual([["vps"]]);
  await click(host.querySelector('[data-rail-place="signed-in:s-render"]'));
  expect(workspaces.open.mock.calls).toHaveLength(1);
  const connect = document.querySelector('[data-place-add="connect-server"]')!;
  expect(connect.textContent).toContain("Connect Render VPS");
  expect(connect.textContent, "it runs OpenMausBot already: only its pairing link is left").not.toContain("npx");
  await type(connect.querySelector("[data-own-server-link]"), "https://render.example.test/#pair=xyz");
  await submit(connect);
  expect(workspaces.add.mock.calls).toEqual([["link", "https://render.example.test/#pair=xyz"]]);
});

it("where no pairing link can be pasted here, a signed-in server not connected yet opens nothing", async () => {
  rail = { places: [place("home", "My Cloud", { active: true }), place("signed-in:s-render", "Render VPS", { kind: "server", opens: false, pairs: true, server: true })],
    add: { cloud: true, link: false, address: false } };
  await mount(createElement(PlacesRail));
  const render = host.querySelector('[data-rail-place="signed-in:s-render"]')!;
  expect(render.getAttribute("aria-disabled")).toBe("true");
  await click(render);
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
});

it("a server of the person's own on an older release than the newest has a quiet reminder; a payment problem's dot comes first", async () => {
  rail = { places: [place("home", "My Cloud", { active: true }),
    place("s-mini", "Mac mini", { kind: "server", server: true, update: { version: "0.1.118", latest: "0.1.130" } }),
    place("s-old", "Old box", { kind: "server", server: true, attention: true, update: { version: "0.1.100", latest: "0.1.130" } })], add: { cloud: true, link: true, address: false } };
  await mount(createElement(PlacesRail));
  expect(host.querySelector('[data-rail-place="s-mini"] [data-rail-update]')).toBeTruthy();
  expect(host.querySelector('[data-rail-place="s-mini"]')?.getAttribute("title")).toContain("on 0.1.118, 0.1.130 is out");
  expect(host.querySelector('[data-rail-place="s-old"] [data-rail-update]')).toBeNull();
  expect(host.querySelector('[data-rail-place="s-old"] [data-rail-dot]')).toBeTruthy();
});

it("the window's own rail: drawn at every width, 36px wide with small rounded tiles named on hover, and its sheets cover the window while open", async () => {
  const expand = vi.fn(async () => {});
  Object.assign(window, { ogb: { workspaces, cloudAdd, rail: { expand, onSkin: () => () => {} } } });
  await mount(createElement(PlacesRail, { chrome: true }));
  const nav = host.querySelector("[data-places-rail]")!;
  expect(nav.className).toContain("flex h-full");
  expect(nav.className.split(" "), "as thin as its tiles allow; beside a window with its own title bar, in the sidebar's colour as before the frame")
    .toEqual(expect.arrayContaining(["w-9", "shrink-0", "flex-col", "items-center", "bg-panel"]));
  expect(nav.className, "never hidden on a narrow window").not.toContain("hidden");
  expect(nav.textContent, "no name under the place on screen: its tile's ring marks it").toBe("MCCAACBCCO");
  expect(host.querySelector('[data-rail-place="home"]')?.getAttribute("title")).toBe("My Cloud");
  expect(host.querySelector('[data-rail-place="home"] span[style]')?.getAttribute("style")).toContain("width: 24px; height: 24px; border-radius: 7px");
  expect(host.querySelector("[data-rail-add]")?.className).toContain("size-6 place-items-center rounded-[7px]");
  expect(expand.mock.calls.at(-1)).toEqual([false]);
  await click(host.querySelector("[data-rail-add]"));
  expect(expand.mock.calls.at(-1), "＋'s sheet covers the window").toEqual([true]);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
  expect(expand.mock.calls.at(-1), "and gives it back once closed").toEqual([false]);
});

it("beside the window's own rail (main says so; the page never reads the list), the sidebar's switcher and Switch to… step aside at every width", async () => {
  rail = { places: [], add: { cloud: false, link: false, address: false }, beside: true };
  await mount(createElement("div", null, createElement(PlacesRail), createElement(DesktopWorkspaceSwitcher, { inline: true })));
  expect(host.querySelector("[data-places-rail]"), "no rail drawn on the page itself").toBeNull();
  expect(host.querySelector("[data-switcher-beside-rail]")?.className).toBe("hidden");
  const { placeMenuItems } = await import("./SidebarProfileMenu");
  const place = { bridge: workspaces, current: { local: false, name: "Office" }, cloudHome: false, onLine: "", openMenu: () => {}, switchable: true } as never;
  expect(placeMenuItems(place, { owner: null, onCloudSettings: () => {} }).map((item) => item.key)).toEqual(["place", "switch-place"]);
  expect(placeMenuItems(place, { owner: null, onCloudSettings: () => {}, besideRail: true }).map((item) => item.key), "one switcher: the rail").toEqual(["place"]);
});

it("a right-click on a circle opens its place's menu: its colour, saved by main whatever its server runs, This computer's too; a member sees who may change it", async () => {
  const expand = vi.fn(async () => {});
  const recolor = vi.fn(async () => ({ outcome: "saved" as const, look: null }));
  rail = { places: [
    place("local", "This computer", { kind: "computer", active: true, color: "teal", paint: { swatch: "green" } }),
    place("vps", "Office", { kind: "server", paint: { swatch: null } }),
    place("acme", "Acme", { kind: "team", color: "purple", paint: { swatch: "violet", locked: "member" } }),
  ], add: { cloud: false, link: true, address: false } };
  Object.assign(window, { ogb: { workspaces: { ...workspaces, recolor }, cloudAdd, rail: { expand, onSkin: () => () => {} } } });
  await mount(createElement(PlacesRail, { chrome: true }));
  const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  const menuOf = async (id: string) => {
    await act(async () => { host.querySelector(`[data-rail-place="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    return host.querySelector(`[data-rail-menu="${id}"]`);
  };
  expect(host.querySelector('[data-rail-place="local"] span[style]')?.getAttribute("style"), "This computer's circle wears its colour").toContain("var(--identity-teal)");
  const own = await menuOf("local");
  expect([own?.getAttribute("aria-label"), own?.querySelector("[aria-checked='true']")?.getAttribute("data-swatch")]).toEqual(["This computer", "green"]);
  expect(own!.querySelector("[data-swatch='slate']")?.getAttribute("aria-label"), "the plain swatch says what it does").toBe("None");
  await click(own!.querySelector("[data-swatch='slate']"));
  await settle();
  expect(recolor).toHaveBeenCalledWith("local", "slate");
  expect([host.querySelector("[data-rail-menu]"), expand.mock.calls.at(-1)]).toEqual([null, [false]]);
  const menu = await menuOf("vps");
  expect(menu?.getAttribute("aria-label")).toBe("Office");
  expect(expand.mock.calls.at(-1), "the menu covers the window while open").toEqual([true]);
  await click(menu!.querySelector("[data-swatch='green']"));
  await settle();
  expect(recolor).toHaveBeenCalledWith("vps", "green");
  expect(host.querySelector("[data-rail-menu]"), "saved: the menu closes, and the circle follows main's list").toBeNull();
  expect(expand.mock.calls.at(-1)).toEqual([false]);
  const locked = await menuOf("acme");
  expect(locked?.querySelector("[data-rail-menu-note]")?.textContent).toBe("Only its admins can change its color.");
  expect([...locked!.querySelectorAll<HTMLButtonElement>("[data-swatch]")].every((swatch) => swatch.disabled), "a member sees it, and can't change it").toBe(true);
  expect(locked!.querySelector("[aria-checked='true']")?.getAttribute("data-swatch")).toBe("violet");
  await act(async () => { locked!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(host.querySelector("[data-rail-menu]")).toBeNull();
});

it("a Cloud of the person's own that ended says so on its circle, and its menu offers Remove from list, asked first; once removed the menu closes", async () => {
  const remove = vi.fn(async (_id: string) => ({ outcome: "refused" as const }) as { outcome: "removed" | "refused" | "gone" | "unsupported" | "failed" });
  rail = { places: [
    place("home", "My Cloud", { active: true, paint: { swatch: null } }),
    place("old", "Old Cloud", { ended: true, removable: true, paint: { swatch: null } }),
    place("a", "Client A", { paint: { swatch: "green" } }),
  ], add: { cloud: false, link: false, address: false } };
  Object.assign(window, { ogb: { workspaces: { ...workspaces, remove }, cloudAdd, rail: { expand: vi.fn(async () => {}), onSkin: () => () => {} } } });
  await mount(createElement(PlacesRail, { chrome: true }));
  const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  const menuOf = async (id: string) => {
    await act(async () => { host.querySelector(`[data-rail-place="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    return host.querySelector(`[data-rail-menu="${id}"]`);
  };
  expect(host.querySelector('[data-rail-place="old"]')?.getAttribute("aria-label")).toBe("Old Cloud: ended");
  expect(host.querySelector('[data-rail-place="old"] [data-rail-ended]'), "dimmed, as a Cloud that isn't running").toBeTruthy();
  expect((await menuOf("a"))?.querySelector("[data-rail-remove]"), "a running Cloud: no such choice").toBeNull();
  await act(async () => { host.querySelector("[data-rail-menu]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  const menu = await menuOf("old");
  await click(menu!.querySelector("[data-rail-remove-ask]"));
  expect(menu!.querySelector("[data-rail-remove] [role='alertdialog'] p")?.textContent).toBe("Remove “Old Cloud” from your list? You can buy a new Cloud any time.");
  expect(remove).not.toHaveBeenCalled();
  await click(menu!.querySelector("[data-rail-remove-confirm]"));
  await settle();
  expect(remove).toHaveBeenCalledWith("old");
  expect(host.querySelector("[data-rail-menu] [role='alert']")?.textContent, "the Admin's no, said plainly").toBe("It can't be removed right now: it is running again, or still has a plan.");
  remove.mockResolvedValueOnce({ outcome: "removed" });
  await click(host.querySelector("[data-rail-menu] [data-rail-remove-ask]"));
  await click(host.querySelector("[data-rail-menu] [data-rail-remove-confirm]"));
  await settle();
  expect(host.querySelector("[data-rail-menu]"), "removed: the menu closes, and the circle goes with main's next list").toBeNull();
  expect(workspaces.places).toHaveBeenCalled();
});

it("a server of the person's own that main offers as home: its menu's one tap starts the move and closes; main's own words when it can't", async () => {
  const makeHome = vi.fn(async (_id: string): Promise<{ started: true }> => { throw new Error("Error invoking remote method 'workspaces:make-home': Error: Garage server has other people on it, so your bots stay here."); });
  rail = { places: [
    place("home", "This computer", { kind: "computer", active: true, paint: { swatch: null } }),
    place("garage", "Garage server", { kind: "server", makeHome: true, paint: { swatch: null } }),
    place("office", "Office", { kind: "server", paint: { swatch: null } }),
  ], add: { cloud: false, link: true, address: false } };
  Object.assign(window, { ogb: { workspaces: { ...workspaces, makeHome }, cloudAdd, rail: { expand: vi.fn(async () => {}), onSkin: () => () => {} } } });
  await mount(createElement(PlacesRail, { chrome: true }));
  const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  const menuOf = async (id: string) => {
    await act(async () => { host.querySelector(`[data-rail-place="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    return host.querySelector(`[data-rail-menu="${id}"]`);
  };
  expect((await menuOf("office"))?.querySelector("[data-rail-make-home]"), "not offered: no such choice").toBeNull();
  await act(async () => { host.querySelector("[data-rail-menu]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  const menu = await menuOf("garage");
  const row = menu!.querySelector("[data-rail-make-home-start]");
  expect(row?.textContent).toBe("Make Garage server my homeMoves this computer's bots, chats, memory and routines to Garage server, and this computer then works for it.");
  await click(row);
  await settle();
  expect(makeHome).toHaveBeenCalledWith("garage");
  expect(host.querySelector("[data-rail-menu] [data-rail-make-home] [role='alert']")?.textContent).toBe("Garage server has other people on it, so your bots stay here.");
  makeHome.mockResolvedValueOnce({ started: true });
  await click(host.querySelector("[data-rail-menu] [data-rail-make-home-start]"));
  await settle();
  expect(host.querySelector("[data-rail-menu]"), "started: the menu closes, and the account says how it goes").toBeNull();
});
