// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PageLending } from "../../electron/cloud-lending-ipc.mjs";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api }));
const { LentComputersCard, lentComputerLines, pageLendingLine } = await import("./LentComputers");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const off: PageLending = { available: true, on: false, status: null, folders: [], screen: false, screenAvailable: true, internet: false, chrome: false, terminal: false };
const lent: PageLending = { available: true, on: true, status: "lent", folders: ["Desktop", "Documents", "Downloads"].map((name) => ({ name, write: false })), screen: false, screenAvailable: true, internet: true, chrome: false, terminal: false };

beforeEach(() => {
  setLocale("en");
  fixture.api.mockReset().mockResolvedValue({ known: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { ogb?: unknown }).ogb;
});
async function render() {
  await act(async () => root.render(createElement(LentComputersCard)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

it("on My Cloud's page in the app, lending this computer is one switch and one line, right here: no leaving My Cloud", async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockResolvedValue(lent);
  (window as { ogb?: unknown }).ogb = { platform: "darwin", cloudLending: { open, state: vi.fn().mockResolvedValue(off), set } };
  await render();
  expect(host.querySelector('[data-lend-this-computer="off"]')).not.toBeNull();
  expect(host.textContent).toContain("Let my bots use this Mac");
  expect(host.textContent).toContain("Off: Cloud bots can't use this computer.");
  expect(host.textContent).not.toContain("Change what's lent");
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(set).toHaveBeenCalledExactlyOnceWith(true);
  expect(open).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Your bots can use the internet connection and Desktop, Documents, and Downloads (read only) on this Mac.");
});

it("on My Cloud's page, Apps and screen is a tick under the switch once lending is on: no leaving My Cloud", async () => {
  const screen = vi.fn().mockResolvedValue({ ...lent, screen: true });
  const state = vi.fn().mockResolvedValue(off);
  (window as { ogb?: unknown }).ogb = { platform: "darwin", cloudLending: { open: vi.fn(), state, set: vi.fn(), screen } };
  await render();
  expect(host.querySelector("[data-lend-screen]")).toBeNull();
  state.mockResolvedValue(lent);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  const tick = host.querySelector<HTMLInputElement>('[data-lend-screen="off"] input')!;
  expect(host.textContent).toContain("Apps and screen");
  expect(host.textContent).toContain("Bots can see your screen and use your apps as you.");
  await act(async () => tick.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(screen).toHaveBeenCalledExactlyOnceWith(true);
  expect(host.querySelector<HTMLInputElement>('[data-lend-screen="on"] input')!.checked).toBe(true);
});

it("on My Cloud's page, the terminal is a tick under the switch once lending is on, and an older app without it shows none", async () => {
  const terminal = vi.fn().mockResolvedValue({ ...lent, terminal: true });
  (window as { ogb?: unknown }).ogb = { platform: "darwin", cloudLending: { open: vi.fn(), state: vi.fn().mockResolvedValue(lent), set: vi.fn(), screen: vi.fn(), terminal } };
  await render();
  const tick = host.querySelector<HTMLInputElement>('[data-lend-terminal="off"] input')!;
  expect(host.textContent).toContain("Terminal");
  expect(host.textContent).toContain("Bots can run any command on this computer as you");
  await act(async () => tick.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(terminal).toHaveBeenCalledExactlyOnceWith(true);
  expect(host.querySelector<HTMLInputElement>('[data-lend-terminal="on"] input')!.checked).toBe(true);
  expect(host.textContent).toContain("and terminal on this Mac");

  await act(async () => root.unmount());
  root = createRoot(host);
  (window as { ogb?: unknown }).ogb = { platform: "darwin", cloudLending: { open: vi.fn(), state: vi.fn().mockResolvedValue(lent), set: vi.fn(), screen: vi.fn() } };
  await render();
  expect(host.querySelector("[data-lend-terminal]")).toBeNull();
});

it("says to set up computer control first where Apps and screen can't be lent yet", async () => {
  (window as { ogb?: unknown }).ogb = { platform: "darwin", cloudLending: { open: vi.fn(), state: vi.fn().mockResolvedValue({ ...lent, screenAvailable: false }), set: vi.fn(), screen: vi.fn() } };
  await render();
  expect(host.querySelector<HTMLInputElement>('[data-lend-screen="off"] input')!.disabled).toBe(true);
  expect(host.textContent).toContain("Set up computer control for this app first");
});

it("in a browser there is no switch for a computer, only the computers lent", async () => {
  fixture.api.mockResolvedValue({ known: [] });
  await render();
  expect(host.querySelector("[data-lend-this-computer]")).toBeNull();
  expect(host.textContent).toContain("No computer is shared with the Cloud.");
});

it("says how lending is going in plain words", () => {
  expect(pageLendingLine(off)).toBe("Off: Cloud bots can't use this computer.");
  expect(pageLendingLine({ ...lent, status: "busy" })).toBe("Cloud bots are using this computer now.");
  expect(pageLendingLine({ ...lent, status: "asleep" })).toBe("The Cloud is asleep. Sharing resumes when it wakes.");
  expect(pageLendingLine({ ...lent, status: "starting" })).toBe("Starting…");
  expect(pageLendingLine({ ...lent, folders: [], screen: true, internet: false })).toBe("Your bots can use apps and screen on this computer.");
  expect(pageLendingLine({ ...lent, link: "unsupported" })).toBe("Your bots can use Desktop, Documents, and Downloads (read only) on this computer. My Cloud is updating. Your bots can use this computer's internet connection once it's done.");
  expect(pageLendingLine({ ...lent, folders: [], link: "unsupported" })).toBe("My Cloud is updating. Your bots can use this computer's internet connection once it's done.");
  expect(pageLendingLine({ ...lent, folders: [], internet: true, link: "connecting" })).toBe("Your bots can use the internet connection on this computer. Internet connection: connecting…");
  expect(pageLendingLine({ ...lent, folders: [], internet: true, link: "on" })).toBe("Your bots can use the internet connection on this computer.");
});

it("a refused folder says why plainly, with no Try again; only a failure trying again can fix says Try again", async () => {
  const set = vi.fn().mockRejectedValueOnce(new Error("Error invoking remote method 'cloud-lending:set': Error: lending-refused:home-or-root"))
    .mockRejectedValueOnce(new Error("Error invoking remote method 'cloud-lending:set': Error: My Cloud didn't answer"));
  (window as { ogb?: unknown }).ogb = { cloudLending: { open: vi.fn(), state: vi.fn().mockResolvedValue(off), set } };
  await render();
  const flip = async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await flip();
  const said = host.querySelector('[role="alert"]')!.textContent!;
  expect(said).toBe("The system disk and the folders above your home folder can't be shared. Choose your home folder itself, a folder inside it, or a separate drive.");
  expect(said).not.toContain("Try again");
  await flip();
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("Could not change what is shared. Try again.");
});

it("on the phone or in a browser, a computer that lends its internet connection says so, and while it is away that the sites that turn away data centres open from My Cloud's own connection", () => {
  const computer = { id: "c", name: "Ash's MacBook", platform: "darwin" as const, online: true, busy: false, lent: true, lastSeenAt: Date.now(), lastUsedAt: null,
    scopes: { folders: 3, terminal: false, screen: false, internet: true } };
  expect(lentComputerLines(computer)).toEqual(["Online now", "Shares: internet connection, 3 folders", "Not used yet"]);
  expect(lentComputerLines({ ...computer, scopes: { ...computer.scopes, folders: 1 } })).toContain("Shares: internet connection, 1 folder");
  const away = lentComputerLines({ ...computer, online: false, lastSeenAt: Date.now() - 5 * 60_000 });
  expect(away).toContain("While it's away, Instagram, YouTube and Google sign-in open from My Cloud's own connection and may turn your bots away.");
  expect(lentComputerLines({ ...computer, online: false, scopes: { ...computer.scopes, internet: false } }).join(" ")).not.toContain("My Cloud's own connection");
  expect(lentComputerLines({ ...computer, online: false, lent: false }).join(" ")).not.toContain("My Cloud's own connection");
});

it("names a lent Chrome on both sides, a Chrome-only grant included", () => {
  expect(pageLendingLine({ ...lent, chrome: true })).toBe("Your bots can use the internet connection, your Chrome, and Desktop, Documents, and Downloads (read only) on this computer.");
  expect(pageLendingLine({ ...lent, folders: [], internet: false, chrome: true })).toBe("Your bots can use your Chrome on this computer.");
  const computer = { id: "c", name: "Ash's MacBook", platform: "darwin" as const, online: true, busy: false, lent: true, lastSeenAt: Date.now(), lastUsedAt: null,
    scopes: { folders: 2, terminal: false, screen: false, internet: true, chrome: true } };
  expect(lentComputerLines(computer)).toContain("Shares: internet connection, Chrome, 2 folders");
  expect(lentComputerLines({ ...computer, scopes: { folders: 0, terminal: false, screen: false, internet: false, chrome: true } })).toContain("Shares: Chrome");
});
