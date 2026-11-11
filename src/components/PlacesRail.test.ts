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
  expect(host.querySelector('[data-rail-place="c"]')?.getAttribute("aria-label")).toBe("Client C: setting up, Cloud");
  expect(host.querySelector('[data-rail-place="pending:c-b"]')?.getAttribute("aria-label")).toBe("Client B: waiting for payment, Cloud");
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
  await click(host.querySelector('[data-rail-place="home"]'));
  await click(host.querySelector('[data-rail-place="a"]'));
  await click(host.querySelector('[data-rail-place="pending:c-b"]'));
  expect(workspaces.open.mock.calls).toEqual([["a"]]);
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const tile = (id: string) => host.querySelector(`[data-rail-place="${id}"]`);
const pending = () => [...host.querySelectorAll("[data-rail-pending]")].map((element) => element.getAttribute("data-rail-place"));
const openWaits = () => { const answer = deferred<undefined>(); workspaces.open.mockImplementationOnce(() => answer.promise); return answer; };

it("the place clicked shows as the one on screen from the click itself, before main has answered, with a pending ring, and the old one stops looking chosen", async () => {
  await mount(createElement(PlacesRail, { chrome: true }));
  const main = openWaits();
  await click(tile("a"));
  expect(workspaces.open.mock.calls).toEqual([["a"]]);
  expect(pending()).toEqual(["a"]);
  expect(tile("a")?.querySelector("[data-rail-ring]")?.getAttribute("data-rail-ring")).toBe("waiting");
  expect(tile("a")?.querySelector("[data-rail-pill]")?.getAttribute("data-rail-pill")).toBe("page");
  expect(tile("home")?.querySelector("[data-rail-pill]")?.getAttribute("data-rail-pill")).toBe("hover");
  await act(async () => { main.resolve(undefined); await main.promise; });
  expect(pending()).toEqual([]);
});

it("a click during a switch replaces it at once, and is not lost: the last click is the one left pending", async () => {
  await mount(createElement(PlacesRail, { chrome: true }));
  const first = openWaits(), second = openWaits(), third = openWaits();
  await click(tile("a"));
  await click(tile("vps"));
  expect(pending()).toEqual(["vps"]);
  await click(tile("c"));
  expect(pending()).toEqual(["c"]);
  expect(workspaces.open.mock.calls).toEqual([["a"], ["vps"], ["c"]]);
  await act(async () => { first.resolve(undefined); await first.promise; });
  await act(async () => { second.resolve(undefined); await second.promise; });
  expect(pending(), "the older switches finishing leave the last one pending").toEqual(["c"]);
  await act(async () => { third.resolve(undefined); await third.promise; });
  expect(pending()).toEqual([]);
});

it("the same place clicked twice while it is pending is one click; the place on screen clicked meanwhile is the last click, and it is not lost", async () => {
  await mount(createElement(PlacesRail, { chrome: true }));
  const first = openWaits(), back = openWaits();
  await click(tile("a"));
  await click(tile("a"));
  expect(workspaces.open.mock.calls).toEqual([["a"]]);
  await click(tile("home"));
  expect(workspaces.open.mock.calls, "main hears the person's change of mind").toEqual([["a"], ["home"]]);
  expect(pending(), "nothing is going anywhere: the place on screen is simply marked again").toEqual([]);
  expect(tile("home")?.querySelector("[data-rail-pill]")?.getAttribute("data-rail-pill")).toBe("page");
  await act(async () => { back.resolve(undefined); await back.promise; });
  await act(async () => { first.resolve(undefined); await first.promise; });
});

it("on the window's own rail the new place's shell covers the page at once and says waking when main does; a place waiting on a bot keeps its ring only", async () => {
  await mount(createElement(PlacesRail, { chrome: true }));
  Object.assign(window, { ogb: { workspaces, cloudAdd, rail: { expand: vi.fn(async () => {}) } } });
  const main = openWaits();
  await click(tile("a"));
  const veil = () => host.querySelector("[data-rail-veil]");
  expect(veil()?.textContent).toContain("Opening Client A…");
  expect((window.ogb!.rail!.expand as ReturnType<typeof vi.fn>).mock.calls.at(-1), "it asks for the whole window while it covers the page").toEqual([true]);
  await act(async () => { rail = { ...rail, switching: { id: "a", waking: true } }; await refreshPlaces(); });
  expect(veil()?.textContent).toContain("Waking My Cloud…");
  await act(async () => { rail = { ...rail, places: rail.places.map((entry) => (entry.id === "a" ? { ...entry, settling: "Sam" } : entry)) }; await refreshPlaces(); });
  expect(veil(), "the work there may take a minute: the page stays to watch").toBeNull();
  expect(pending()).toEqual(["a"]);
  await act(async () => { main.resolve(undefined); await main.promise; });
});

it("a rail drawn on a page draws no shell of its own: its page is the one going away", async () => {
  await mount(createElement(PlacesRail));
  const main = openWaits();
  await click(tile("a"));
  expect(pending()).toEqual(["a"]);
  expect(host.querySelector("[data-rail-veil]")).toBeNull();
  await act(async () => { main.resolve(undefined); await main.promise; });
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

it("＋ offers buying a Cloud or connecting to the person's own server: a box for its link or address, sent to main", async () => {
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  const sheet = document.querySelector("[data-place-add-sheet]")!;
  expect([...sheet.querySelectorAll("[data-place-add-choice]")].map((choice) => choice.getAttribute("data-place-add-choice"))).toEqual(["cloud", "server"]);
  await click(sheet.querySelector('[data-place-add-choice="server"]'));
  const form = document.querySelector('[data-place-add="own-server"]')!;
  expect(form.textContent).toContain("Link or address");
  expect(form.textContent, "no commands before the person starts typing").not.toContain("npx");
  expect(document.activeElement).toBe(form.querySelector("[data-own-server-link]"));
  const connect = [...form.querySelectorAll("button")].find((button) => button.textContent === "Connect")!;
  expect(connect.disabled, "nothing pasted yet").toBe(true);
  await type(form.querySelector("[data-own-server-link]"), "  https://bots.example.test/#pair=abc  ");
  await submit(form);
  expect(workspaces.add.mock.calls).toEqual([["link", "https://bots.example.test/#pair=abc", ""]]);
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
});

it("a pasted link main can't open says so and keeps the sheet; cancelling main's Connect keeps it too", async () => {
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await click(document.querySelector('[data-place-add-choice="server"]'));
  const form = document.querySelector('[data-place-add="own-server"]')!;
  await type(form.querySelector("[data-own-server-link]"), "not a link");
  workspaces.add.mockRejectedValueOnce(new Error("Error invoking remote method 'workspaces:add': Error: That isn't a server address."));
  await submit(form);
  expect(form.querySelector('[role="alert"]')?.textContent).toBe("That isn't a server address.");
  expect(document.querySelector("[data-place-add-sheet]")).toBeTruthy();
  await type(form.querySelector("[data-own-server-link]"), "https://bots.example.test/#pair=abc");
  expect(form.querySelector('[role="alert"]'), "editing the link clears the error").toBeNull();
  workspaces.add.mockResolvedValueOnce(false);
  await submit(form);
  expect(document.querySelector("[data-place-add-sheet]"), "the person cancelled Connect").toBeTruthy();
});

const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 450)); });

it("Connect to a server never sits grey without saying why: it says it is looking, and says so when the check itself fails", async () => {
  let answer: (value: unknown) => void = () => {};
  const probe = vi.fn((): Promise<unknown> => new Promise((resolve, reject) => { answer = resolve; void reject; }));
  Object.assign(window, { ogb: { workspaces: { ...workspaces, probe }, cloudAdd } });
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await click(document.querySelector('[data-place-add-choice="server"]'));
  const form = document.querySelector('[data-place-add="own-server"]')!;
  await type(form.querySelector("[data-own-server-link]"), "http://192.168.1.20:8799/#pair=ABCD-EFGH-JKLM");
  await settle();
  expect(form.querySelector("[data-connect-checking]")?.textContent).toBe("Looking for the server…");
  expect((form.querySelector("[data-own-server-connect]") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { answer({ outcome: "problem", problem: "localNetwork", host: "192.168.1.20:8799" }); });
  expect(form.querySelector("[data-connect-checking]")).toBeNull();
  expect(form.querySelector("[data-connect-problem]")?.textContent).toContain("Privacy & Security → Local Network");
  probe.mockImplementation(() => Promise.reject(new Error("IPC failed")));
  await type(form.querySelector("[data-own-server-link]"), "http://192.168.1.21:8799/#pair=ABCD-EFGH-JKLM");
  await settle();
  expect(form.querySelector("[data-connect-problem]")?.textContent).toBe("Can't reach 192.168.1.21:8799. Check the server is running and reachable from this computer.");
});

it("Connect to a server says plainly that another computer's desktop app can't be connected to, and points to My Cloud", async () => {
  const probe = vi.fn(async (address: string): Promise<unknown> => (address === "123456"
    ? { outcome: "problem", problem: "oldCode" }
    : { outcome: "problem", problem: "desktopApp", host: "192.168.1.30:8799" }));
  Object.assign(window, { ogb: { workspaces: { ...workspaces, probe }, cloudAdd } });
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await click(document.querySelector('[data-place-add-choice="server"]'));
  const form = document.querySelector('[data-place-add="own-server"]')!;
  await type(form.querySelector("[data-own-server-link]"), "192.168.1.30:8799");
  await settle();
  const line = form.querySelector("[data-connect-problem]")?.textContent ?? "";
  expect(line).toContain("192.168.1.30:8799 is a MausBot desktop app, and one desktop app can't connect to another");
  expect(line).toContain("My Cloud");
  expect(line).not.toContain("isn't a MausBot server");
  expect((form.querySelector("[data-own-server-connect]") as HTMLButtonElement).disabled).toBe(true);
  // The 6-digit code a desktop app shows for pairing a phone gets the same pointer, not "a code from an older MausBot".
  await type(form.querySelector("[data-own-server-link]"), "123456");
  await settle();
  expect(form.querySelector("[data-connect-problem]")?.textContent).toContain("That 6-digit code pairs a phone with a desktop app");
});

it("Connect to a server takes an address and a code typed apart: a code pasted alone moves to its field, and main names the server it found", async () => {
  const probe = vi.fn(async (address: string): Promise<unknown> => (address.includes("192.168.1.20")
    ? { outcome: "found", origin: "http://192.168.1.20:8799", label: "kitchen-box", version: "0.1.147", transport: "private-http", code: null, credential: null }
    : { outcome: "problem", problem: "publicHttp", host: "203.0.113.9" }));
  Object.assign(window, { ogb: { workspaces: { ...workspaces, probe }, cloudAdd } });
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await click(document.querySelector('[data-place-add-choice="server"]'));
  const form = document.querySelector('[data-place-add="own-server"]')!;
  await type(form.querySelector("[data-own-server-link]"), "abcd-efgh-jklm");
  expect((form.querySelector("[data-own-server-link]") as HTMLInputElement).value, "the code left the address field").toBe("");
  expect((form.querySelector("[data-own-server-code]") as HTMLInputElement).value).toBe("ABCD-EFGH-JKLM");
  expect(form.querySelector("[data-connect-hint]")?.textContent).toBe("Now add the server's address, like http://192.168.1.20:8799.");
  await type(form.querySelector("[data-own-server-link]"), "http://203.0.113.9");
  await settle();
  expect(form.querySelector("[data-connect-problem]")?.textContent).toContain("http://203.0.113.9 is on the open internet");
  expect((form.querySelector("[data-own-server-connect]") as HTMLButtonElement).disabled).toBe(true);
  await type(form.querySelector("[data-own-server-link]"), "192.168.1.20:8799");
  await settle();
  expect(probe).toHaveBeenLastCalledWith("192.168.1.20:8799", "ABCD-EFGH-JKLM");
  expect(form.querySelector("[data-connect-found]")?.textContent).toBe("✓ kitchen-box · MausBot 0.1.147 · Private network, not encrypted. Fine on your own network or Tailscale.");
  expect(form.querySelector("[data-connect-problem]")).toBeNull();
  const button = form.querySelector("[data-own-server-connect]") as HTMLButtonElement;
  expect([button.disabled, button.textContent]).toEqual([false, "Connect to kitchen-box"]);
  expect(form.textContent).toContain("npx openmausbot pair");
  workspaces.add.mockResolvedValueOnce({ outcome: "problem", problem: "unreachable", host: "192.168.1.20:8799" });
  await submit(form);
  expect(form.querySelector('[role="alert"]')?.textContent).toBe("Can't reach 192.168.1.20:8799. Check the server is running and reachable from this computer.");
  workspaces.add.mockResolvedValueOnce({ outcome: "connected", label: "kitchen-box" });
  await submit(form);
  expect(workspaces.add.mock.calls.at(-1)).toEqual(["link", "192.168.1.20:8799", "ABCD-EFGH-JKLM"]);
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
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
  expect(workspaces.add.mock.calls).toEqual([["link", "https://render.example.test/#pair=xyz", ""]]);
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
  expect(host.querySelector("[data-rail-add]")?.className).toContain("size-6 place-items-center rounded-[8px]");
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
  expect(host.querySelector('[data-rail-place="old"]')?.getAttribute("aria-label")).toBe("Old Cloud: ended, Cloud");
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

const ALICE = "alice@example.test", BOB = "bob@example.test";
const accounts = { list: vi.fn(async () => ({ active: { id: "a", email: ALICE } })), onChanged: vi.fn(() => () => {}), signOut: vi.fn(), addStart: vi.fn(), addVerify: vi.fn(), addBrowser: vi.fn(), addReopen: vi.fn(), addCancel: vi.fn(async () => {}) };
const TWO_ACCOUNTS: RailPlace[] = [
  place("local", "This computer", { kind: "computer", active: true }),
  place("a1", "My Cloud", { color: "purple", group: "active", email: ALICE }),
  place("a2", "Acme", { kind: "team", group: "active", email: ALICE }),
  place("b1", "My Cloud", { color: "teal", group: "b", email: BOB }),
  place("account:c", "carol@example.test", { kind: "account", group: "c", email: "carol@example.test" }),
  place("vps", "Office", { kind: "server", group: "hand" }),
];

it("one account: no divider and no address, exactly as before", async () => {
  await mount(createElement(PlacesRail));
  expect(host.querySelector("[data-rail-divider]")).toBeNull();
  expect(host.innerHTML).not.toContain("@");
});

it("several accounts: a thin divider between groups, This computer first, and each tooltip names the account, so two called My Cloud can be told apart", async () => {
  rail = { places: TWO_ACCOUNTS, add: { cloud: true, link: true, address: false } };
  await mount(createElement(PlacesRail));
  expect(host.querySelectorAll("[data-rail-divider]").length).toBe(4);
  const items = [...host.querySelectorAll("nav li")].map((row) => [row.querySelector("[data-rail-divider]") !== null, row.querySelector("[data-rail-place]")?.getAttribute("data-rail-place")]);
  expect(items).toEqual([[false, "local"], [true, "a1"], [false, "a2"], [true, "b1"], [true, "account:c"], [true, "vps"]]);
  expect(host.querySelector('[data-rail-place="a1"]')?.getAttribute("title")).toBe(`My Cloud · ${ALICE}`);
  expect(host.querySelector('[data-rail-place="b1"]')?.getAttribute("title")).toBe(`My Cloud · ${BOB}`);
  expect(host.querySelector('[data-rail-place="vps"]')?.getAttribute("title")).toBe("Office");
  expect(host.querySelector('[data-rail-place="account:c"]')?.getAttribute("title")).toBe("carol@example.test");
});

it("a click on another account's place asks main by its id; a refusal shows the plain line, and nothing else moves", async () => {
  rail = { places: TWO_ACCOUNTS, add: { cloud: true, link: true, address: false } };
  Object.assign(window, { ogb: { workspaces, cloudAdd, accounts } });
  workspaces.open.mockResolvedValueOnce({ outcome: "moving" } as never);
  await mount(createElement(PlacesRail));
  await click(host.querySelector('[data-rail-place="b1"]'));
  await act(async () => { await Promise.resolve(); });
  expect(workspaces.open.mock.calls).toEqual([["b1"]]);
  expect(document.querySelector("[data-accounts-note]")?.textContent).toContain("moving to the Cloud");
  expect(document.querySelector("[data-accounts-sign-out]")).toBeNull();
});

it("a saved account whose sign-in ended: its tile says so, and a click opens the emailed code for that address", async () => {
  const ended = TWO_ACCOUNTS.map((row) => (row.id === "b1" ? { ...row, signIn: true as const } : row));
  rail = { places: ended, add: { cloud: true, link: true, address: false } };
  Object.assign(window, { ogb: { workspaces, cloudAdd, accounts } });
  workspaces.open.mockResolvedValueOnce({ outcome: "sign-in", email: BOB } as never);
  await mount(createElement(PlacesRail));
  expect(host.querySelector('[data-rail-place="b1"]')?.getAttribute("title")).toBe(`My Cloud · ${BOB} · Sign in again`);
  await click(host.querySelector('[data-rail-place="b1"]'));
  await act(async () => { await Promise.resolve(); });
  expect((document.querySelector("#cloud-add-email") as HTMLInputElement | null)?.value).toBe(BOB);
});

it("＋ offers Add another account while someone is signed in, and it opens the sign-in over the window", async () => {
  rail = { places: TWO_ACCOUNTS, add: { cloud: true, link: true, address: false, account: true } };
  Object.assign(window, { ogb: { workspaces, cloudAdd, accounts } });
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  await click(document.querySelector('[data-place-add-choice="account"]'));
  await act(async () => { await Promise.resolve(); });
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
  expect((document.querySelector("#cloud-add-email") as HTMLInputElement | null)?.value).toBe("");
});

it("past eight, ⋯ keeps the groups, each under its address, and search finds a place by its account's address", async () => {
  const many = [place("local", "This computer", { kind: "computer" }), ...Array.from({ length: 5 }, (_, at) => place(`a${at}`, `A ${at}`, { group: "active", email: ALICE })), ...Array.from({ length: 5 }, (_, at) => place(`b${at}`, `B ${at}`, { group: "b", email: BOB }))];
  rail = { places: many, add: { cloud: false, link: false, address: false } };
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-more-button]"));
  const groups = [...host.querySelectorAll("[data-rail-more] [data-rail-group]")].map((row) => row.textContent);
  expect(groups).toEqual([ALICE, BOB]);
  const rowsText = [...host.querySelectorAll("[data-rail-more] button")].map((row) => row.textContent);
  expect(rowsText.join(" ")).not.toContain("@");
  expect(matchingPlaces(many, "bob@").map((row) => row.id)).toEqual(["b0", "b1", "b2", "b3", "b4"]);
});

it("colours stay per Cloud, whichever account it belongs to", async () => {
  rail = { places: TWO_ACCOUNTS, add: { cloud: false, link: false, address: false } };
  await mount(createElement(PlacesRail));
  const fill = (id: string) => (host.querySelector(`[data-rail-place="${id}"] [aria-hidden="true"][style]`) as HTMLElement | null)?.getAttribute("style");
  expect(fill("a1")).not.toEqual(fill("b1"));
});

it("＋ stands for Add another account alone, when nothing else can be added", async () => {
  rail = { places: TWO_ACCOUNTS, add: { cloud: false, link: false, address: false, account: true } };
  await mount(createElement(PlacesRail));
  expect(host.querySelector("[data-rail-add]")).not.toBeNull();
  rail = { places: TWO_ACCOUNTS, add: { cloud: false, link: false, address: false } };
  await act(async () => { await refreshPlaces(); });
  expect(host.querySelector("[data-rail-add]")).toBeNull();
});

it("once My Cloud is home, This Mac (This PC elsewhere) is a laptop circle that says what it is, and a click opens it through main by its profile id", async () => {
  const mac = place("profile:default", "This computer", { kind: "computer", profile: "default" });
  rail = { places: [mac, ...PLACES], add: { cloud: true, link: true, address: false } };
  Object.assign(window, { ogb: { workspaces, cloudAdd, platform: "darwin" } });
  await mount(createElement(PlacesRail));
  const tile = host.querySelector('[data-rail-place="profile:default"]');
  expect(tile?.getAttribute("aria-label")).toBe("This Mac: a separate place on this computer, with its own bots. The bots on My Cloud stay there.");
  expect(tile?.getAttribute("data-rail-kind")).toBe("computer");
  await click(tile);
  expect(workspaces.open.mock.calls).toEqual([["profile:default"]]);
  Object.assign(window, { ogb: { workspaces, cloudAdd, platform: "win32" } });
  expect(placeLabel(mac)).toBe("This PC: a separate place on this computer, with its own bots. The bots on My Cloud stay there.");
  expect(matchingPlaces([mac, ...PLACES], "pc").map((entry) => entry.id)).toEqual(["profile:default"]);
  expect(placeLabel(place("local", "This computer", { kind: "computer" })), "before the move it is This computer, as ever").toBe("This computer");
});

it("a small cloud sits at the corner of every Cloud's tile, its own, a team's and another account's, and a screen reader hears Cloud; never on this computer, a workspace or a server", async () => {
  const mac = place("profile:default", "This computer", { kind: "computer", profile: "default", paint: { swatch: null } });
  const work = place("profile:work", "Work", { kind: "computer", profile: "work", named: true, color: "teal", paint: { swatch: "green" } });
  rail = { places: [mac, work, PLACES[0]!, PLACES[2]!, PLACES[3]!, place("vps2", "Mini", { kind: "cloud", server: true }), place("acct:b", "b@example.test", { kind: "account" }),
    place("other", "Their Cloud", { group: "b", email: "b@example.test" })], add: { cloud: true, link: true, address: false } };
  Object.assign(window, { ogb: { workspaces, cloudAdd, platform: "darwin" } });
  await mount(createElement(PlacesRail));
  const badged = [...host.querySelectorAll("[data-rail-place]")].filter((tile) => tile.querySelector("[data-rail-cloud]")).map((tile) => tile.getAttribute("data-rail-place"));
  expect(badged.sort()).toEqual(["acme", "home", "other", "pending:c-b"].sort());
  expect(host.querySelector('[data-rail-place="home"]')?.getAttribute("aria-label")).toBe("My Cloud, Cloud");
  expect(host.querySelector('[data-rail-place="other"]')?.getAttribute("aria-label")).toBe("Their Cloud · b@example.test, Cloud");
  expect(host.querySelector('[data-rail-place="home"]')?.getAttribute("title"), "the tooltip stays the place's own words").toBe("My Cloud");
  expect(host.querySelector('[data-rail-place="profile:default"]')?.getAttribute("aria-label")).not.toContain("Cloud,");
  expect(host.querySelector('[data-rail-place="profile:work"] [data-rail-local]'), "a named workspace: a laptop at its corner").toBeTruthy();
  expect(host.querySelector('[data-rail-place="profile:work"]')?.textContent, "its initials, as a place with a name").toBe("W");
  expect(host.querySelector('[data-rail-place="profile:work"]')?.getAttribute("aria-label")).toBe("Work: a separate place on this computer, with its own bots");
  expect(host.querySelector('[data-rail-place="profile:default"] [data-rail-local]'), "This Mac is the laptop itself").toBeNull();
  expect(host.querySelector('[data-rail-place="vps2"] [data-rail-server]'), "a server of the person's own keeps its server mark").toBeTruthy();
  const badge = host.querySelector('[data-rail-place="home"] [data-rail-cloud]')!;
  expect(badge.getAttribute("class")).toContain("border-(--rail-surface)");
  expect(badge.getAttribute("aria-hidden")).toBe("true");
});

it("a workspace that opens once a bot in the one running finishes: a waiting ring, and its tooltip says so", async () => {
  rail = { places: [place("local", "This computer", { kind: "computer", settling: "" }), place("profile:work", "Work", { kind: "computer", profile: "work", named: true, active: true, settling: "Scout" })],
    add: { cloud: false, link: false, address: false, local: true } };
  await mount(createElement(PlacesRail));
  expect(host.querySelector('[data-rail-place="profile:work"]')?.getAttribute("aria-label")).toBe("Work opens once Scout finishes");
  expect(host.querySelector('[data-rail-place="profile:work"] [data-rail-ring]')?.getAttribute("data-rail-ring")).toBe("waiting");
  expect(host.querySelector('[data-rail-place="local"]')?.getAttribute("aria-label")).toBe("This computer opens once the work there finishes");
});

it("＋ offers a new workspace on this computer first, to Cloud owners too: a name (Work, then Personal, then Workspace 2) and a colour no place has, then main makes and opens it", async () => {
  const create = vi.fn(async (_name: string, _color: unknown) => ({ outcome: "made" as const, id: "personal" }) as { outcome: "made"; id: string } | { outcome: "name" | "taken" | "failed" });
  const mac = place("profile:default", "This computer", { kind: "computer", profile: "default", paint: { swatch: null } });
  rail = { places: [mac, place("profile:work", "Work", { kind: "computer", profile: "work", named: true, paint: { swatch: "blue" } }), ...PLACES], add: { cloud: true, link: true, address: false, local: true } };
  Object.assign(window, { ogb: { workspaces: { ...workspaces, local: { create, edit: vi.fn(), remove: vi.fn() } }, cloudAdd, platform: "darwin" } });
  await mount(createElement(PlacesRail));
  expect(host.querySelector("[data-rail-add]")?.getAttribute("aria-label")).toBe("Add a place for your bots");
  await click(host.querySelector("[data-rail-add]"));
  const sheet = document.querySelector("[data-place-add-sheet]")!;
  expect([...sheet.querySelectorAll("[data-place-add-choice]")].map((choice) => choice.getAttribute("data-place-add-choice"))).toEqual(["local", "cloud", "server"]);
  expect(sheet.querySelector('[data-place-add-choice="local"]')?.textContent).toContain("New workspace on this computer");
  await click(sheet.querySelector('[data-place-add-choice="local"]'));
  let form = document.querySelector('[data-place-add="local"]')!;
  const name = form.querySelector<HTMLInputElement>("[data-local-name]")!;
  expect(name.value, "Work is taken here: the next first name").toBe("Personal");
  expect(document.activeElement).toBe(name);
  expect(form.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("data-swatch"), "a colour no place here has: My Cloud is violet, Client A green, Work blue").toBe("amber");
  await click([...form.querySelectorAll("button")].find((button) => button.textContent === "Back") ?? null);
  expect(document.querySelector('[data-place-add="choose"]'), "Back: the choices again").toBeTruthy();
  await click(document.querySelector('[data-place-add-choice="local"]'));
  form = document.querySelector('[data-place-add="local"]')!;
  await type(form.querySelector("[data-local-name]"), "   ");
  expect(form.querySelector<HTMLButtonElement>("[data-local-create]")!.disabled, "no name: nothing to create").toBe(true);
  await type(form.querySelector("[data-local-name]"), " this mac ");
  await submit(form);
  expect(form.querySelector("[data-local-problem]")?.textContent, "a name a place here has, said at once").toBe("Another place here has that name. Choose another.");
  expect(create).not.toHaveBeenCalled();
  await type(form.querySelector("[data-local-name]"), " Side   project ");
  await click(form.querySelector('[data-swatch="rose"]'));
  await submit(form);
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  expect(create.mock.calls).toEqual([["Side project", "rose"]]);
  expect(document.querySelector("[data-place-add-sheet]"), "made: the sheet closes, and the rail shows it opening").toBeNull();
  await click(host.querySelector("[data-rail-add]"));
  await click(document.querySelector('[data-place-add-choice="local"]'));
  create.mockResolvedValueOnce({ outcome: "taken" });
  await submit(document.querySelector('[data-place-add="local"]'));
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  expect(document.querySelector("[data-local-problem]")?.textContent, "main's own no").toBe("Another place here has that name. Choose another.");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.querySelector("[data-place-add-sheet]"), "Escape closes it, nothing made").toBeNull();
  expect(create).toHaveBeenCalledTimes(2);
});

it("with only the new workspace to add, ＋ goes straight to its name, and Close leaves nothing behind", async () => {
  const create = vi.fn();
  rail = { places: [place("local", "This computer", { kind: "computer", active: true }), place("vps", "Office", { kind: "server" })], add: { cloud: false, link: false, address: false, local: true } };
  Object.assign(window, { ogb: { workspaces: { ...workspaces, local: { create, edit: vi.fn(), remove: vi.fn() } }, cloudAdd } });
  await mount(createElement(PlacesRail));
  await click(host.querySelector("[data-rail-add]"));
  const form = document.querySelector('[data-place-add="local"]')!;
  expect(form.querySelector<HTMLInputElement>("[data-local-name]")!.value).toBe("Work");
  expect([...form.querySelectorAll("button")].some((button) => button.textContent === "Back"), "nothing to go back to").toBe(false);
  await click(document.querySelector('[data-place-add-sheet] [aria-label="Close"]'));
  expect(document.querySelector("[data-place-add-sheet]")).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

it("a workspace's menu: Rename (Enter saves, Escape leaves it), its colour, and Remove asked first in plain words; Cancel changes nothing", async () => {
  const edit = vi.fn(async (_id: string, _changes: unknown) => ({ outcome: "saved" as const }) as { outcome: "saved" | "taken" | "name" | "full" | "gone" });
  const remove = vi.fn(async (_id: string) => ({ outcome: "removed" as const }) as { outcome: "removed" | "gone" | "failed" });
  rail = { places: [place("profile:default", "This computer", { kind: "computer", profile: "default", paint: { swatch: null } }),
    place("profile:work", "Work", { kind: "computer", profile: "work", named: true, active: true, paint: { swatch: "green" } }), ...PLACES], add: { cloud: true, link: true, address: false, local: true } };
  Object.assign(window, { ogb: { workspaces: { ...workspaces, local: { create: vi.fn(), edit, remove } }, cloudAdd, platform: "darwin", rail: { expand: vi.fn(async () => {}), onSkin: () => () => {} } } });
  await mount(createElement(PlacesRail, { chrome: true }));
  const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  const menuOf = async (id: string) => {
    await act(async () => { host.querySelector(`[data-rail-place="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    return host.querySelector(`[data-rail-menu="${id}"]`)!;
  };
  let menu = await menuOf("profile:work");
  expect(menu.getAttribute("aria-label")).toBe("Work");
  expect(document.activeElement, "the first row takes the focus").toBe(menu.querySelector("[data-rail-rename]"));
  await click(menu.querySelector("[data-rail-rename]"));
  const field = menu.querySelector<HTMLInputElement>("[data-rail-rename-form] input")!;
  expect(field.value).toBe("Work");
  await type(field, "Office");
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(menu.querySelector("[data-rail-rename-form]"), "Escape leaves the name as it was").toBeNull();
  expect(host.querySelector("[data-rail-menu]"), "and the menu stays").toBeTruthy();
  expect(edit).not.toHaveBeenCalled();
  await click(menu.querySelector("[data-rail-rename]"));
  await type(menu.querySelector("[data-rail-rename-form] input"), "  Office ");
  edit.mockResolvedValueOnce({ outcome: "taken" });
  await submit(menu.querySelector("[data-rail-rename-form]"));
  await settle();
  expect(menu.querySelector("[data-rail-rename-form] [role='alert']")?.textContent).toBe("Another place here has that name. Choose another.");
  await submit(menu.querySelector("[data-rail-rename-form]"));
  await settle();
  expect(edit.mock.calls, "by the circle's own id, which main listed").toEqual([["profile:work", { name: "Office" }], ["profile:work", { name: "Office" }]]);
  expect(host.querySelector("[data-rail-menu]"), "saved: the menu closes").toBeNull();
  menu = await menuOf("profile:work");
  await click(menu.querySelector('[data-rail-local-color] [data-swatch="violet"]'));
  await settle();
  expect(edit.mock.calls.at(-1)).toEqual(["profile:work", { color: "violet" }]);
  menu = await menuOf("profile:default");
  await click(menu.querySelector('[data-rail-local-color] [data-swatch="slate"]'));
  expect(edit.mock.calls.length, "None is This Mac's colour already: nothing to save").toBe(3);
  await click(menu.querySelector("[data-rail-remove-ask]"));
  expect(menu.querySelector("[role='alertdialog'] p")?.textContent).toBe("Remove “This Mac”? Its bots, chats and files on this computer are deleted. Its folder goes to the Trash first.");
  await click(menu.querySelector("[data-rail-remove-cancel]"));
  expect(remove, "Cancel: nothing removed").not.toHaveBeenCalled();
  expect(menu.querySelector("[data-rail-remove-ask]"), "and the menu as it was").toBeTruthy();
  await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  menu = await menuOf("profile:work");
  await click(menu.querySelector("[data-rail-remove-ask]"));
  remove.mockResolvedValueOnce({ outcome: "failed" });
  await click(menu.querySelector("[data-rail-remove-confirm]"));
  await settle();
  expect(host.querySelector("[data-rail-menu] [role='alert']")?.textContent).toBe("It wasn't removed. Try again in a moment.");
  await click(host.querySelector("[data-rail-menu] [data-rail-remove-ask]"));
  await click(host.querySelector("[data-rail-menu] [data-rail-remove-confirm]"));
  await settle();
  expect(remove.mock.calls).toEqual([["profile:work"], ["profile:work"]]);
  expect(host.querySelector("[data-rail-menu]"), "removed: the menu closes, and the tile goes with main's next list").toBeNull();
  Object.assign(window, { ogb: { ...window.ogb, platform: "win32" } });
  menu = await menuOf("profile:work");
  await click(menu.querySelector("[data-rail-remove-ask]"));
  expect(menu.querySelector("[role='alertdialog'] p")?.textContent).toContain("Recycle Bin");
});

it("two quick clicks: the place still marked can be clicked to stay, so the last click wins; on its own it opens nothing", async () => {
  rail = { places: [place("profile:default", "This computer", { kind: "computer", profile: "default" }), place("profile:work", "Work", { kind: "computer", profile: "work", named: true, active: true }), ...PLACES.slice(1)],
    add: { cloud: false, link: false, address: false } };
  await mount(createElement(PlacesRail));
  await click(host.querySelector('[data-rail-place="profile:work"]'));
  expect(workspaces.open, "the place on screen: nothing to open").not.toHaveBeenCalled();
  await click(host.querySelector('[data-rail-place="profile:default"]'));
  await click(host.querySelector('[data-rail-place="profile:work"]'));
  expect(workspaces.open.mock.calls).toEqual([["profile:default"], ["profile:work"]]);
});
