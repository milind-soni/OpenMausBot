// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotWorkingFolderActions } from "./BotWorkingFolderActions";

const mocks = vi.hoisted(() => ({ api: vi.fn(), copy: vi.fn(), allowed: true as boolean | null }));
vi.mock("@/state/store", () => ({ api: mocks.api }));
vi.mock("@/lib/copy-text", () => ({ copyText: mocks.copy }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => mocks.allowed }));
let root: Root;
let host: HTMLDivElement;
let reveal: ReturnType<typeof vi.fn>;
const bot = { id: "atlas", threadId: "atlas-thread" };
const folder = { path: "C:\\fixture\\Atlas", local: true };
const openButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Open working folder on this computer"]')!;
const copyButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Copy working folder path"]')!;

beforeEach(() => {
  mocks.allowed = true;
  mocks.api.mockReset().mockResolvedValue(folder);
  mocks.copy.mockReset().mockResolvedValue("copied");
  reveal = vi.fn().mockResolvedValue("shown");
  Object.defineProperty(window, "ogb", { configurable: true, value: { revealInFolder: reveal } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, "ogb");
});
function render(props = {}) {
  flushSync(() => root.render(createElement(BotWorkingFolderActions, { bot, ...props })));
}
async function ready() {
  await vi.waitFor(() => expect(openButton()?.disabled).toBe(false));
}

describe("bot working folder actions", () => {
  it.each([
    { menu: false, allowed: false }, { menu: true, allowed: false },
    { menu: false, allowed: null }, { menu: true, allowed: null },
  ])("does not mount folder actions without confirmed access: %j", ({ menu, allowed }) => {
    mocks.allowed = allowed;
    render({ menu });
    expect(mocks.api).not.toHaveBeenCalled();
    expect(host.childElementCount).toBe(0);
    expect(document.querySelector('[data-notice-toast]')).toBeNull();
  });

  it("waits for admin access before requesting the folder", async () => {
    mocks.allowed = null;
    render();
    expect(mocks.api).not.toHaveBeenCalled();
    mocks.allowed = true;
    render();
    await ready();
    expect(mocks.api).toHaveBeenCalledOnce();
  });

  it("prepares the folder then reveals the server-returned path and closes a menu", async () => {
    const closed = vi.fn();
    render({ menu: true, onCompleted: closed });
    await ready();
    expect(copyButton()).toBeNull();
    expect(openButton().title).toBe(folder.path);
    expect(openButton().getAttribute("role")).toBe("menuitem");
    mocks.api.mockResolvedValueOnce({ path: "C:\\fixture\\Updated", local: true });
    openButton().click();
    await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("C:\\fixture\\Updated"));
    expect(mocks.api).toHaveBeenLastCalledWith("/api/bots/atlas/working-folder?threadId=atlas-thread", { method: "POST", body: "{}" });
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith("open");
  });

  it.each(["remote", "browser", "server"])("shows only Copy path for %s", async (kind) => {
    if (kind === "remote") Object.defineProperty(window, "ogb", { value: { revealInFolder: reveal, remoteClient: { active: true } } });
    if (kind === "browser") Reflect.deleteProperty(window, "ogb");
    if (kind === "server") mocks.api.mockResolvedValue({ ...folder, local: false });
    render();
    await vi.waitFor(() => expect(copyButton()).not.toBeNull());
    expect(openButton()).toBeNull();
    copyButton().click();
    await vi.waitFor(() => expect(document.querySelector('[data-notice-toast]')?.textContent).toContain("Path copied"));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(mocks.copy).toHaveBeenCalledWith(folder.path);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("hides opening when the bot has no host folder", async () => {
    mocks.api.mockResolvedValue({ path: null, local: false });
    render({ menu: true });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    expect(openButton()).toBeNull();
    expect(copyButton()).toBeNull();
  });

  it.each(["prepare", "missing", "invalid", "rejected"])("shows an opening failure for %s and keeps the menu open", async (failure) => {
    const closed = vi.fn();
    render({ menu: true, onCompleted: closed });
    await ready();
    if (failure === "prepare") mocks.api.mockRejectedValueOnce(new Error("denied"));
    else if (failure === "rejected") reveal.mockRejectedValueOnce(new Error("denied"));
    else reveal.mockResolvedValueOnce(failure);
    openButton().click();
    await vi.waitFor(() => expect(document.querySelector('[data-notice-toast]')?.textContent).toContain("Could not open"));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(openButton().disabled).toBe(false);
  });

  it.each(["copied", "failed"])("closes the copy menu only on success: %s", async (result) => {
    const completed = vi.fn();
    mocks.api.mockResolvedValue({ ...folder, local: false });
    mocks.copy.mockResolvedValue(result);
    render({ menu: true, onCompleted: completed });
    await vi.waitFor(() => expect(copyButton()).not.toBeNull());
    copyButton().click();
    if (result === "copied") {
      await vi.waitFor(() => expect(completed).toHaveBeenCalledWith("copy"));
      expect(completed).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() => expect(document.querySelector('[data-notice-toast]')?.textContent).toContain("Could not copy path"));
      expect(completed).not.toHaveBeenCalled();
    }
  });

  it("drops a pending open after switching bots", async () => {
    render();
    await ready();
    let complete!: (value: typeof folder) => void;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    openButton().click();
    render({ bot: { id: "juniper", threadId: "juniper-thread" } });
    await ready();
    complete(folder);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reveal).not.toHaveBeenCalled();
  });

  it("drops a pending open when switching conversations of the same bot", async () => {
    render();
    await ready();
    let complete!: (value: typeof folder) => void;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    openButton().click();
    mocks.api.mockResolvedValueOnce({ path: "C:\\fixture\\Sibling", local: true });
    render({ bot: { ...bot, threadId: "sibling" } });
    await ready();
    expect(openButton().title).toBe("C:\\fixture\\Sibling");
    expect(mocks.api).toHaveBeenLastCalledWith("/api/bots/atlas/working-folder?threadId=sibling");
    complete(folder);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reveal).not.toHaveBeenCalled();
  });

  it("refreshes the path when the selected task's pinned folder changes", async () => {
    render();
    await ready();
    mocks.api.mockResolvedValueOnce({ path: "C:\\fixture\\Pinned", local: true });
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, cwd: "C:\\fixture\\Pinned" }] } });
    await vi.waitFor(() => expect(openButton()?.title).toBe("C:\\fixture\\Pinned"));
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("refreshes an unpinned conversation when its folder becomes explicitly unknown", async () => {
    render();
    await ready();
    mocks.api.mockResolvedValueOnce({ path: null, local: false });
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, cwd: null }] } });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
    expect(openButton()).toBeNull();
    expect(copyButton()).toBeNull();
  });

  it("does not show a previous bot's late response", async () => {
    let complete!: (value: typeof folder) => void;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    render();
    mocks.api.mockResolvedValueOnce({ path: "C:\\fixture\\Juniper", local: true });
    render({ bot: { id: "juniper", threadId: "juniper-thread" } });
    await ready();
    complete(folder);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openButton().title).toBe("C:\\fixture\\Juniper");
  });
});
