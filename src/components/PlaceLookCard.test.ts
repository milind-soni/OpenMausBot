// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaceLook } from "../../electron/place-look.mjs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); vi.resetModules(); });

const look = (over: Partial<PlaceLook> = {}): PlaceLook => ({ name: "Client A", color: "teal", swatch: "green", change: "admin", ...over });
const COMPUTER: PlaceLook = { name: "This computer", color: null, swatch: null, change: "local" };
const COLOR: Record<string, PlaceLook["color"]> = { blue: "blue", green: "teal", amber: "yellow", rose: "red", violet: "purple", slate: null };
const saved = (from: PlaceLook) => (swatch: string | null) => ({ outcome: "saved", look: { ...from, color: COLOR[swatch ?? "slate"] ?? null, swatch: COLOR[swatch ?? "slate"] ? swatch as PlaceLook["swatch"] : null } });
const SET = { version: "v1", width: 1200, height: 300 };

/** The page's bridge, and the card and tint as a fresh page loads them (the look is shared across the page). `own`: this
 * computer's own page in the desktop app; `owner`: what the server says of whoever is signed in. */
async function page(start: PlaceLook | null, { answer = saved(start ?? COMPUTER), own = false, owner = true, banner = null as typeof SET | null } = {}) {
  vi.resetModules();
  vi.doMock("@/state/store", () => ({ useStore: () => ({ state: { config: { workspaceBanner: banner } } }) }));
  vi.doMock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => owner }));
  const pictures = { upload: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })) };
  vi.doMock("@/lib/place-banner", async (original) => ({ ...(await original<typeof import("@/lib/place-banner")>()),
    prepareBanner: async (file: Blob) => ({ ok: true, blob: file }), uploadBanner: pictures.upload, removeBanner: pictures.remove }));
  let changed: () => void = () => {};
  const workspaces = { look: vi.fn(async () => start), color: vi.fn(async (swatch: string | null) => answer(swatch)), onChanged: vi.fn((callback: () => void) => { changed = callback; return () => {}; }) };
  Object.assign(window, { ogb: { app: { version: "0.1.131", ownPage: own }, workspaces } });
  const { setLocale } = await import("@/lib/i18n");
  setLocale("en");
  const { PlaceLookCard } = await import("./PlaceLookCard");
  const { PlaceTint } = await import("./PlaceTint");
  root = createRoot(host);
  await act(async () => { root!.render(createElement("div", null, createElement(PlaceTint), createElement(PlaceLookCard))); });
  await act(async () => { await Promise.resolve(); });
  return { workspaces, pictures, changed: () => changed() };
}
const swatch = (name: string) => host.querySelector(`[data-swatch="${name}"]`) as HTMLButtonElement;
const checked = () => [...host.querySelectorAll("[data-swatch]")].filter((button) => button.getAttribute("aria-checked") === "true").map((button) => button.getAttribute("data-swatch"));
const tint = () => host.querySelector("[data-place-tint]")?.getAttribute("style") ?? null;
const button = (words: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === words) as HTMLButtonElement | undefined;
const click = async (target: HTMLElement) => { await act(async () => { target.click(); await Promise.resolve(); }); await act(async () => { await Promise.resolve(); }); };

it("the tint: a place's colour in the skin's own tone; no colour, or one this app doesn't draw, leaves the sidebar as it was", async () => {
  const { placeTint } = await import("@/lib/place-look");
  expect(placeTint("teal")).toEqual({ "--place-tint": "var(--identity-teal)" });
  expect(placeTint("orange")).toEqual({ "--place-tint": "var(--identity-orange)" });
  for (const none of [null, undefined, "", "slate", "url(x)", "teal;background:red"]) expect(placeTint(none)).toBeNull();
  await page(look({ color: null, swatch: "slate" }));
  expect(host.querySelector("[data-place-tint]")).toBeNull();
});

it("this computer, by default: plain, nothing chosen, in plain words with no picture yet", async () => {
  await page(COMPUTER, { own: true });
  expect([checked(), tint(), host.querySelector("[data-place-banner]")], "no colour, no tint, no picture: the sidebar as it always was").toEqual([[], null, null]);
  expect(host.querySelector("[data-place-picture]")?.getAttribute("data-place-picture")).toBe("none");
  const words = host.querySelector("[data-sidebar-look]")!.textContent!;
  for (const said of ["Sidebar color", "Tints the top of the sidebar.", "Sidebar picture", "Your own image, faded into the top of the sidebar."]) expect(words).toContain(said);
  expect(words, "no Cloud's words on this computer").not.toMatch(/This computer|place|workspace|Everyone here|admins/i);
  expect(host.querySelector("[role='radiogroup']")?.getAttribute("aria-label")).toBe("Sidebar color");
  expect([swatch("slate").getAttribute("aria-label"), swatch("slate").disabled, button("Use an image")?.disabled], "None, and both changeable here").toEqual(["None", false, false]);
  expect(host.querySelector("[data-sidebar-look]")?.getAttribute("data-settings-look"), "in the Simple look in Advanced too").toBe("simple");
});

it("this computer takes a colour and a picture, both shown at once; None and Remove make it plain again", async () => {
  const { workspaces, pictures } = await page(COMPUTER, { own: true });
  await click(swatch("green"));
  expect(workspaces.color).toHaveBeenLastCalledWith("green");
  expect(checked()).toEqual(["green"]);
  expect(tint(), "the sidebar takes it at once").toContain("var(--identity-teal)");
  await click(swatch("slate"));
  expect(workspaces.color).toHaveBeenLastCalledWith("slate");
  expect([checked(), tint()], "None: no tint, and nothing chosen, as at first").toEqual([[], null]);

  const input = host.querySelector("[data-place-picture-input]") as HTMLInputElement;
  const file = new File(["png"], "beach.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  expect(pictures.upload, "kept on this computer's own server").toHaveBeenCalledWith(file);

  await act(async () => root?.unmount());
  const kept = await page({ ...COMPUTER, color: "teal", swatch: "green" }, { own: true, banner: SET });
  expect(host.querySelector("[data-place-banner] img")?.getAttribute("src"), "the server's word on the picture: the sidebar shows it").toBe("/api/workspace/banner?v=v1");
  expect(host.querySelector("[data-place-tint]")?.hasAttribute("data-under-banner"), "the colour waits under it").toBe(true);
  expect(host.querySelector("[data-place-picture] img")?.getAttribute("alt"), "and Settings shows it").toBe("Current picture");
  await click(button("Remove")!);
  expect(kept.pictures.remove, "Remove asks this computer's server to forget it").toHaveBeenCalled();
});

it("a solo Cloud's owner changes both its colour (on the Admin) and its picture", async () => {
  const { workspaces } = await page(look({ name: "My Cloud", color: null, swatch: null }));
  expect(host.textContent).toContain("My Cloud shows in this color at the top of the sidebar and on its circle at the window's left edge.");
  expect(host.textContent).toContain("Everyone here sees it.");
  expect([swatch("rose").disabled, button("Use an image")?.disabled]).toEqual([false, false]);
  await click(swatch("rose"));
  expect(workspaces.color).toHaveBeenCalledWith("rose");
  expect(checked()).toEqual(["rose"]);
  expect(tint()).toContain("var(--identity-red)");
});

it("choosing a swatch saves it through main, and the tint follows at once", async () => {
  const { workspaces } = await page(look());
  expect(tint()).toContain("var(--identity-teal)");
  expect(swatch("green").getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("Client A shows in this color at the top of the sidebar and on its circle at the window's left edge.");
  await click(swatch("rose"));
  expect(workspaces.color).toHaveBeenCalledWith("rose");
  expect(swatch("rose").getAttribute("aria-checked")).toBe("true");
  expect(tint()).toContain("var(--identity-red)");
  await act(async () => { swatch("rose").click(); await Promise.resolve(); });
  expect(workspaces.color).toHaveBeenCalledTimes(1);
});

it("a team member sees the team's colour and picture and who may change them, and their clicks change nothing", async () => {
  const { workspaces, pictures } = await page(look({ name: "Acme", change: null, reason: "member" }), { owner: false, banner: SET });
  expect([...host.querySelectorAll("[data-swatch]")].every((candidate) => (candidate as HTMLButtonElement).disabled)).toBe(true);
  expect(host.querySelector('[data-place-look="locked"]')?.textContent).toContain("Only its admins can change its color.");
  await click(swatch("rose"));
  expect(workspaces.color).not.toHaveBeenCalled();
  expect(tint(), "they still see it").toContain("var(--identity-teal)");
  expect([button("Change image")?.disabled, button("Remove")?.disabled]).toEqual([true, true]);
  expect(host.querySelector("[data-place-picture]")?.textContent).toContain("Only its admins can change its picture.");
  await click(button("Remove")!);
  expect(pictures.remove).not.toHaveBeenCalled();
  expect(host.querySelector("[data-place-banner] img"), "they see the picture").toBeTruthy();
});

it("the Admin's refusal, an Admin without the route, and a failure: said plainly, and the colour stays", async () => {
  for (const [outcome, words] of [["refused", "Only its admins can change its color."], ["unsupported", "This Cloud's color can't be changed from the app yet."], ["failed", "The color wasn't saved. Try again."]] as const) {
    await act(async () => root?.unmount());
    await page(look(), { answer: () => ({ outcome, look: look() }) });
    await click(swatch("rose"));
    expect(host.textContent).toContain(words);
    expect(swatch("green").getAttribute("aria-checked")).toBe("true");
  }
});

it("another Cloud of the person's own while the MausBot Cloud sign-in is away: locked, and says why", async () => {
  await page(look({ change: null, reason: "signed-out" }));
  expect(host.querySelector('[data-place-look="locked"]')?.textContent).toContain("Sign in to MausBot Cloud to change its color.");
  expect(swatch("rose").disabled).toBe(true);
});

it("a browser or an older app: no colour and no tint, only the place's picture", async () => {
  await page(null);
  expect(host.querySelector("[data-swatch]")).toBeNull();
  expect(host.querySelector("[data-place-tint]")).toBeNull();
  expect(host.querySelector("[data-place-picture]")).toBeTruthy();
  expect(host.textContent).toContain("Your own image, faded into the top of the sidebar. Everyone here sees it.");
  await act(async () => root?.unmount());
  vi.resetModules();
  vi.doMock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
  vi.doMock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
  Object.assign(window, { ogb: { workspaces: { state: vi.fn() } } });
  const { PlaceLookCard } = await import("./PlaceLookCard");
  root = createRoot(host);
  await act(async () => { root!.render(createElement(PlaceLookCard)); });
  expect(host.querySelector("[data-swatch]")).toBeNull();
});

it("main's word that the place changed (another window, the Admin, the rail): the card and tint read it again", async () => {
  const { workspaces, changed } = await page(look());
  workspaces.look.mockResolvedValueOnce(look({ color: "purple", swatch: "violet" }));
  await act(async () => { changed(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  expect(swatch("violet").getAttribute("aria-checked")).toBe("true");
  expect(tint()).toContain("var(--identity-purple)");
});
