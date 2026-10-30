// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const banner = vi.hoisted(() => ({ prepare: vi.fn(), upload: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/place-banner", async (original) => ({
  ...(await original<typeof import("@/lib/place-banner")>()),
  prepareBanner: banner.prepare, uploadBanner: banner.upload, removeBanner: banner.remove,
}));
const { setLocale } = await import("@/lib/i18n");
const { PlacePicture } = await import("./PlacePicture");
const { PlaceTop } = await import("./PlaceTint");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); vi.clearAllMocks(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });
const render = async (element: ReturnType<typeof createElement>) => {
  root ??= createRoot(host);
  await act(async () => { root!.render(element); });
  await act(async () => { await Promise.resolve(); });
};
const SET = { version: "v1", width: 1200, height: 300 };
const button = (words: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === words) as HTMLButtonElement | undefined;
const choose = async (file: File) => {
  const input = host.querySelector("[data-place-picture-input]") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};

it("the top of the sidebar: the banner picture first, then the place's colour, then nothing, as before", async () => {
  await render(createElement(PlaceTop, { banner: SET, color: "teal" }));
  expect(host.querySelector("[data-place-banner] img")?.getAttribute("src")).toBe("/api/workspace/banner?v=v1");
  expect(host.querySelector("[data-place-tint]")?.hasAttribute("data-under-banner"), "the colour waits under the picture").toBe(true);
  await act(async () => { host.querySelector("[data-place-banner] img")!.dispatchEvent(new Event("error")); });
  expect(host.querySelector("[data-place-banner]"), "a picture that won't load gives way").toBeNull();
  expect(host.querySelector("[data-place-tint]")?.hasAttribute("data-under-banner")).toBe(false);
  await render(createElement(PlaceTop, { banner: null, color: "teal" }));
  expect(host.querySelector("[data-place-banner]")).toBeNull();
  expect(host.querySelector("[data-place-tint]")?.getAttribute("style")).toContain("var(--identity-teal)");
  await render(createElement(PlaceTop, { banner: null, color: null }));
  expect(host.innerHTML).toBe("");
  await render(createElement(PlaceTop, { banner: { ...SET, version: "v2" }, color: null }));
  expect([Boolean(host.querySelector("[data-place-banner]")), host.querySelector("[data-place-tint]")], "a new picture is tried again").toEqual([true, null]);
});

it("whoever may change the workspace's settings picks a picture: shrunk and cleaned here, then kept on the server", async () => {
  const blob = new Blob(["x"], { type: "image/webp" });
  banner.prepare.mockResolvedValue({ ok: true, blob });
  banner.upload.mockResolvedValue({ ok: true });
  banner.remove.mockResolvedValue({ ok: true });
  await render(createElement(PlacePicture, { banner: null, canChange: true }));
  expect(host.querySelector("[data-place-picture]")?.getAttribute("data-place-picture")).toBe("none");
  expect(button("Use an image")?.disabled).toBe(false);
  expect((host.querySelector("[data-place-picture-input]") as HTMLInputElement).accept).toBe("image/png,image/jpeg,image/webp");
  const picked = new File(["png"], "beach.png", { type: "image/png" });
  await choose(picked);
  expect(banner.prepare).toHaveBeenCalledWith(picked);
  expect(banner.upload).toHaveBeenCalledWith(blob);
  await render(createElement(PlacePicture, { banner: SET, canChange: true }));
  expect(host.querySelector("img")?.getAttribute("alt")).toBe("Current picture");
  await act(async () => { button("Remove")!.click(); await Promise.resolve(); });
  expect(banner.remove).toHaveBeenCalled();
});

it("a picture that can't be used is said plainly, and nothing is sent", async () => {
  for (const [problem, words] of [["format", "Use a PNG, JPEG or WebP picture."], ["read", "That picture couldn't be read. Try another one."], ["size", "That picture is too large. Try a smaller one."]] as const) {
    vi.clearAllMocks();
    banner.prepare.mockResolvedValue({ ok: false, problem });
    await render(createElement(PlacePicture, { banner: null, canChange: true }));
    await choose(new File(["gif"], "moving.gif", { type: "image/gif" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(words);
    expect(banner.upload).not.toHaveBeenCalled();
  }
  banner.prepare.mockResolvedValue({ ok: true, blob: new Blob(["x"]) });
  banner.upload.mockResolvedValue({ ok: false, problem: "animated" });
  await choose(new File(["webp"], "anim.webp"));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Use a still picture.");
});

it("a team member sees the picture and who may change it, and can't", async () => {
  await render(createElement(PlacePicture, { banner: SET, canChange: false }));
  expect(button("Change image")?.disabled).toBe(true);
  expect(button("Remove")?.disabled).toBe(true);
  expect(host.textContent).toContain("Only its admins can change its picture.");
  await choose(new File(["png"], "x.png"));
  expect(banner.prepare).not.toHaveBeenCalled();
});
