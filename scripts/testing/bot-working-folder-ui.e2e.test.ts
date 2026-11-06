import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import { launchVerificationServer } from "../control-omb.ts";

const fixtureState = vi.hoisted(() => ({ url: "" }));
vi.mock("@/state/store", () => ({
  api: async (path: string, init?: RequestInit) => {
    const response = await fetch(`${fixtureState.url}${path}`, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
}));

it("opens a bot folder through rendered actions and an isolated server", async () => {
  const fixture = await launchVerificationServer();
  const window = new Window();
  let unmount: (() => void) | undefined;
  try {
    fixtureState.url = fixture.info.url;
    const created = await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Folder UI fixture" }) });
    expect(created.status).toBe(201);
    const { bot } = await created.json() as { bot: { id: string } };
    const expected = join(fixture.info.dataDir, "workspaces", bot.id);
    const reveal = vi.fn(async () => "shown");
    const copy = vi.fn(async () => {});
    Object.assign(window, { ogb: { revealInFolder: reveal } });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: copy } });
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("navigator", window.navigator);
    const { flushSync } = await import("react-dom");
    const { createRoot } = await import("react-dom/client");
    const { BotWorkingFolderActions } = await import("../../src/components/BotWorkingFolderActions.tsx");
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    unmount = () => flushSync(() => root.unmount());
    for (const menu of [false, true]) {
      flushSync(() => root.render(createElement(BotWorkingFolderActions, { bot, menu })));
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Open working folder on this computer"]')).not.toBeNull());
      const open = host.querySelector<HTMLButtonElement>('[aria-label="Open working folder on this computer"]')!;
      expect(host.querySelector('[aria-label="Copy working folder path"]')).toBeNull();
      await vi.waitFor(() => expect(open.disabled).toBe(false));
      expect(open.title).toBe(expected);
      open.click();
      await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(menu ? 2 : 1));
      await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith(expected));
      expect((await stat(expected)).isDirectory()).toBe(true);
    }
    expect(reveal).toHaveBeenCalledTimes(2);
    Object.assign(window, { ogb: { revealInFolder: reveal, remoteClient: { active: true } } });
    for (const menu of [false, true]) {
      flushSync(() => root.render(createElement(BotWorkingFolderActions, { bot, menu })));
      const copyPath = host.querySelector<HTMLButtonElement>('[aria-label="Copy working folder path"]')!;
      expect(copyPath).not.toBeNull();
      expect(host.querySelector('[aria-label="Open working folder on this computer"]')).toBeNull();
      copyPath.click();
      await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(menu ? 2 : 1));
      expect(copy).toHaveBeenCalledWith(expected);
      await vi.waitFor(() => expect(window.document.querySelector('[data-notice-toast]')?.textContent).toBe("Path copied"));
    }
    expect(reveal).toHaveBeenCalledTimes(2);
    console.log(JSON.stringify({ action: "open local folder or copy remote path from header and menu", ...fixture.info, path: expected }));
  } finally {
    unmount?.();
    await window.happyDOM.close();
    vi.unstubAllGlobals();
    await fixture.close();
  }
});
