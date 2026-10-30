// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api }));
const { SignedInSites } = await import("./SignedInSites");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const google = { site: "google.com", cookies: 4, storage: 1 };
const example = { site: "example.com", cookies: 1, storage: 0 };

beforeEach(() => {
  fixture.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(props: Parameters<typeof SignedInSites>[0]) {
  await act(async () => root.render(createElement(SignedInSites, props)));
}
// Opening a <details> fires its toggle event, as in a browser.
async function open() {
  await act(async () => { host.querySelector("details")!.open = true; });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label)!;
async function click(label: string) {
  await act(async () => button(label).click());
}
const listed = () => [...host.querySelectorAll("li span")].map((span) => span.textContent);

describe("signed-in sites", () => {
  it("loads only when opened, then lists each site", async () => {
    fixture.api.mockResolvedValueOnce({ running: false, sites: [example, google] });
    await render({ target: { profile: "profile-work" }, sharedBy: ["Pepper"] });
    expect(fixture.api).not.toHaveBeenCalled();
    await open();
    expect(fixture.api).toHaveBeenCalledWith("/api/browser-sites?profile=profile-work");
    expect(listed()).toEqual(["example.com", "google.com"]);
    expect(host.textContent).not.toContain("share this browser");
  });

  it("bare, it has no fold or title and loads as soon as it is shown", async () => {
    fixture.api.mockResolvedValueOnce({ running: true, sites: [example, google] }).mockResolvedValueOnce({ running: true, sites: [google] });
    await render({ bare: true, target: { bot: "pepper" }, sharedBy: ["Pepper"] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/browser-sites?bot=pepper");
    expect(host.querySelector("details")).toBeNull();
    expect(host.textContent).not.toContain("Signed-in sites");
    expect(listed()).toEqual(["example.com", "google.com"]);
    await click("Sign out of example.com");
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(listed()).toEqual(["google.com"]);
  });

  it("signs out of one site, and shows what is left", async () => {
    fixture.api.mockResolvedValueOnce({ running: true, sites: [example, google] }).mockResolvedValueOnce({ running: true, sites: [example] });
    await render({ target: { bot: "pepper" }, sharedBy: ["Pepper"] });
    await open();
    await click("Sign out of google.com");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/browser-sites/sign-out", { method: "POST", body: JSON.stringify({ bot: "pepper", site: "google.com" }) });
    expect(listed()).toEqual(["example.com"]);
  });

  it("on a Team Cloud, reads and signs out of the browser of the conversation shown", async () => {
    fixture.api.mockResolvedValueOnce({ running: true, sites: [example] }).mockResolvedValueOnce({ running: true, sites: [] });
    await render({ bare: true, target: { bot: "pepper" }, scope: { threadId: "ada-chat" }, sharedBy: ["Pepper"] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenCalledWith("/api/browser-sites?bot=pepper&threadId=ada-chat");
    await click("Sign out of example.com");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/browser-sites/sign-out", { method: "POST", body: JSON.stringify({ bot: "pepper", threadId: "ada-chat", site: "example.com" }) });
  });

  it("signs out of all, and says when nothing is left", async () => {
    fixture.api.mockResolvedValueOnce({ running: false, sites: [example, google] }).mockResolvedValueOnce({ running: false, sites: [] });
    await render({ target: { profile: "profile-work" }, sharedBy: ["Pepper", "Scout"] });
    await open();
    expect(host.textContent).toContain("Pepper, Scout share this browser: signing out here signs all of them out.");
    await click("Sign out of all");
    expect(fixture.api).toHaveBeenLastCalledWith("/api/browser-sites/sign-out", { method: "POST", body: JSON.stringify({ profile: "profile-work" }) });
    expect(host.textContent).toContain("Not signed in to any site.");
    expect(host.querySelector("button")).toBeNull();
  });

  it("shows the server's reason when it cannot read the browser, and keeps buttons off while disabled", async () => {
    fixture.api.mockRejectedValueOnce(new Error("The browser did not answer. Try again when the bot has finished."));
    await render({ target: { profile: "profile-work" }, sharedBy: [] });
    await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("The browser did not answer. Try again when the bot has finished.");
    fixture.api.mockResolvedValueOnce({ running: false, sites: [google] });
    await render({ target: { profile: "profile-other" }, sharedBy: [], disabled: true });
    await act(async () => { host.querySelector("details")!.open = false; });
    await open();
    expect(button("Sign out of google.com").disabled).toBe(true);
    expect(button("Sign out of all").disabled).toBe(true);
  });
});
