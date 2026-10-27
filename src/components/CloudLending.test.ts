import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudLendingBridge, CloudLendingSnapshot } from "../../electron/computer-sharing.mjs";
import { setLocale, t } from "@/lib/i18n";
import { localeChoices, locales } from "@/locales";
import type { LocaleKey } from "@/locales";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CloudLending, lendingFailureKey, lendingStatusKey, lendingStoppedLine, lendingTitle, lentWhat, thisDevice } from "./CloudLending";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { checked: boolean } }) => void; role?: string; type?: string; "aria-label"?: string; disabled?: boolean; checked?: boolean; "data-lending-more"?: boolean; "data-lending-terminal-choice"?: boolean; "data-lending-internet-choice"?: boolean; "data-lending-chrome-choice"?: boolean; }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
let bridge: CloudLendingBridge;
function render() { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudLending({ bridge }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture)); return { html, nodes: nodes(tree) }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const folder = { id: "11111111-1111-4111-8111-111111111111", name: "Plans", path: "/Users/me/Plans", write: false };
const off: CloudLendingSnapshot = { available: true, screenAvailable: true, state: { enabled: false, folders: [], screen: false, internet: false, chrome: false, busy: false }, activity: [] };
const lent: CloudLendingSnapshot = { available: true, screenAvailable: true, state: { enabled: true, folders: [folder], screen: false, internet: false, chrome: false, busy: false, connected: true }, activity: [] };
async function ready(snapshot: CloudLendingSnapshot) {
  vi.mocked(bridge.state).mockResolvedValue(snapshot);
  render(); const cleanup = f.effects[0]!(); await flush(); return cleanup;
}
const toggle = () => render().nodes.find(node => node.props.role === "switch" || node.props["aria-label"] === "Let my bots use this computer")!;
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = [];
  bridge = { state: vi.fn(), chooseFolder: vi.fn().mockResolvedValue(folder), save: vi.fn().mockResolvedValue(lent), stop: vi.fn().mockResolvedValue(off) };
  vi.stubGlobal("window", { confirm: vi.fn(() => { throw new Error("no confirmation dialogs"); }) });
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); });

it("says where lending stands in one line", () => {
  expect(lendingStatusKey(lent, true)).toBe("lending.status.lent");
  expect(lendingStatusKey({ ...lent, state: { ...lent.state!, busy: true } }, true)).toBe("lending.status.busy");
  expect(lendingStatusKey({ ...lent, state: { ...lent.state!, connected: false, problem: "connect-first" } }, true)).toBe("lending.status.connectFirst");
  expect(lendingStatusKey({ ...lent, state: { ...lent.state!, connected: false } }, true)).toBe("lending.status.starting");
  expect(lendingStatusKey(off, true)).toBe("lending.status.starting");
  expect(lendingStatusKey(off, false)).toBeNull();
  expect(lendingStatusKey({ ...off, state: { ...off.state!, problem: "signed-out" } }, false)).toBe("lending.status.signedOut");
});

it("shows nothing until the person is signed in to a known Cloud", async () => {
  await ready({ available: false, screenAvailable: false });
  expect(render().html).toBe("");
});

const more = () => render().nodes.find(node => node.props["data-lending-more"])!.props.onClick!();

it("is one switch, off by default; turning it on lends at once (main picks the internet connection and the usual folders when none were chosen) and says what is lent", async () => {
  await ready(off);
  let view = render();
  expect(view.html).toContain("Let my bots use this computer");
  expect(view.html).not.toContain("Apps and screen");
  toggle().props.onClick!();
  await flush();
  expect(bridge.save).toHaveBeenCalledExactlyOnceWith({ folders: [], screen: false, internet: false });
  const usual = ["Desktop", "Documents", "Downloads"].map((name, i) => ({ ...folder, id: `${i}1111111-1111-4111-8111-111111111111`, name, path: `/Users/me/${name}` }));
  await ready({ ...lent, state: { ...lent.state!, folders: usual, internet: true } });
  view = render();
  expect(view.html).toContain("Your bots can use the internet connection and Desktop, Documents, and Downloads (read only) on this computer.");
  // The choices wait behind Choose what's lent.
  expect(view.html).not.toContain("Add folder");
  more();
  view = render();
  expect(view.html).toContain("Add folder");
  expect(view.html).toContain("If someone else writes in a conversation, it can no longer use your computer.");
});

it("names what is lent in one phrase", () => {
  expect(lentWhat([{ name: "Plans", write: false }], false)).toBe("Plans (read only)");
  expect(lentWhat([{ name: "Plans", write: true }, { name: "Notes", write: false }], true)).toBe("Plans (can edit), Notes, and apps and screen");
  expect(lentWhat([], true)).toBe("apps and screen");
  expect(lentWhat([], false, true)).toBe("the internet connection");
  expect(lentWhat([{ name: "Plans", write: true }], true, true)).toBe("the internet connection, Plans (can edit), and apps and screen");
});

it("names this computer as the person knows it: this Mac, this PC, else this computer", () => {
  expect([thisDevice("darwin"), thisDevice("win32"), thisDevice("linux"), thisDevice(undefined)]).toEqual(["mac", "pc", "computer", "computer"]);
  expect([lendingTitle("mac"), lendingTitle("pc"), lendingTitle("computer")]).toEqual(["Let my bots use this Mac", "Let my bots use this PC", "Let my bots use this computer"]);
});

it("the internet connection is a choice of its own: ticking it lends it, and unticking everything stops lending", async () => {
  await ready({ ...lent, state: { ...lent.state!, folders: [], internet: false, screen: true } });
  more();
  const choice = () => render().nodes.find(node => node.type === "input" && (node.props as Record<string, unknown>)["data-lending-internet-choice"])!;
  expect(choice().props.checked).toBe(false);
  choice().props.onChange!({ target: { checked: true } });
  await flush();
  expect(bridge.save).toHaveBeenLastCalledWith({ folders: [], screen: true, internet: true });
  // Still open under Choose what's lent.
  await ready({ ...lent, state: { ...lent.state!, folders: [], internet: true, screen: false } });
  expect(render().html).toContain("Internet connection");
  choice().props.onChange!({ target: { checked: false } });
  await flush();
  expect(bridge.stop).toHaveBeenCalledOnce();
});

it("a computer that shares only its internet connection by default reads naturally: on, connecting until the link opens, and its switch ticked", async () => {
  const internetOnly = (link: "on" | "connecting") => ({ ...lent, state: { ...lent.state!, folders: [], internet: true, link } });
  await ready(internetOnly("connecting"));
  expect(render().html).toContain("Your bots can use the internet connection on this computer.");
  expect(render().html).toContain("Internet connection: connecting…");
  await ready(internetOnly("on"));
  expect(render().html).toContain("Internet connection: on");
  expect(render().html).not.toContain("connecting…");
  more();
  const choice = render().nodes.find(node => node.type === "input" && (node.props as Record<string, unknown>)["data-lending-internet-choice"])!;
  expect(choice.props.checked).toBe(true);
  await ready({ ...lent, state: { ...lent.state!, internet: false } });
  expect(render().html).not.toContain("Internet connection: ");
  await ready({ ...off, state: { ...off.state!, internet: true, stopped: { reason: "you", at: 1 } } });
  expect(render().html).not.toContain("Internet connection: ");
});

it("says so while My Cloud is too old to browse through this computer", async () => {
  await ready({ ...lent, state: { ...lent.state!, internet: true, link: "unsupported" } });
  expect(render().html).toContain("Your bots can use Plans (read only) on this computer.");
  expect(render().html).toContain("My Cloud is updating. Your bots can use this computer&#x27;s internet connection once it&#x27;s done.");
  await ready({ ...lent, state: { ...lent.state!, internet: true, link: "on" } });
  expect(render().html).not.toContain("My Cloud is updating");
});

it("while lent, says so, shows this computer's activity, and removing the last choice stops lending instead of saving nothing", async () => {
  await ready({ ...lent, state: { ...lent.state!, busy: true }, activity: [{ at: 1_790_000_000_000, server: "My Cloud", origin: "https://c.test", action: "read_file", detail: "Plans/todo.md", ok: true }] });
  more();
  const view = render();
  expect(view.html).toContain("Cloud bots are using this computer now.");
  expect(view.html).toContain("Plans/todo.md");
  expect(view.html).toContain("Read a file");
  view.nodes.find(node => node.props["aria-label"] === "Remove Plans")!.props.onClick!();
  await flush();
  expect(bridge.stop).toHaveBeenCalledOnce();
  expect(bridge.save).not.toHaveBeenCalled();
});

it("a site opened through this computer's internet connection is activity too, and counts as My Cloud using it", async () => {
  await ready({ ...lent, state: { ...lent.state!, internet: true }, activity: [
    { at: Date.now() - 60_000, server: "My Cloud", origin: "https://c.test", action: "internet", detail: "www.instagram.com", ok: true },
    { at: Date.now() - 2 * 60_000, server: "My Cloud", origin: "https://c.test", action: "internet", detail: "router.home.test", ok: false, error: "home-network" },
  ] });
  more();
  const html = render().html;
  expect(html).toContain("Opened a website");
  expect(html).toContain("www.instagram.com");
  expect(html).toContain("Opened a website · refused");
  expect(html).not.toContain("Other request");
  expect(html).toContain("Cloud bots last used this computer 1 minute ago.");
});

it("turning the switch off stops lending at once", async () => {
  await ready(lent);
  toggle().props.onClick!();
  await flush();
  expect(bridge.stop).toHaveBeenCalledOnce();
});

it("apps and screen cannot be chosen until this app's computer control is ready", async () => {
  await ready({ ...lent, screenAvailable: false });
  more();
  const view = render();
  const checkbox = view.nodes.find(node => node.type === "input" && node.props.checked === false && node.props.disabled === true);
  expect(checkbox).toBeTruthy();
  expect(view.html).toContain("Set up computer control for this app first");
});

// A customer saw the switch off while his computer still showed apps and screen lent, with no reason given.
it("an off switch says why and since when, keeps the choices, and the switch lends the same again", async () => {
  const at = new Date(2026, 9, 7, 14, 2).getTime();
  const stopped: CloudLendingSnapshot = { available: true, screenAvailable: true, activity: [],
    state: { enabled: false, folders: [folder], screen: true, internet: false, chrome: false, busy: false, stopped: { reason: "signed-out", at } } };
  expect(lendingStoppedLine(stopped.state)).toBe("Off since Oct 7, 2026, 2:02 PM, when you signed out of MausBot Cloud.");
  expect(lendingStoppedLine({ ...stopped.state!, stopped: { reason: "you", at } })).toBe("Off since Oct 7, 2026, 2:02 PM: you turned it off.");
  expect(lendingStoppedLine({ ...stopped.state!, stopped: { reason: "something-new", at } })).toBe("Off since Oct 7, 2026, 2:02 PM.");
  expect(lendingStoppedLine(lent.state)).toBeNull();
  await ready(stopped);
  const view = render();
  expect(view.html).toContain('data-lending-stopped="signed-out"');
  expect(view.html).not.toContain("Apps and screen<");
  expect(view.html).not.toContain("Lend the same again");
  toggle().props.onClick!();
  await flush();
  expect(vi.mocked(bridge.save).mock.calls).toEqual([[{ folders: [folder], screen: true, internet: false }]]);
});

it("while the bots move to My Cloud, an off switch says it turns on by itself once they are there, unless the person turned it off", async () => {
  const view = async (snapshot: CloudLendingSnapshot, moving: boolean) => {
    f.values = []; vi.mocked(bridge.state).mockResolvedValue(snapshot);
    const draw = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(() => CloudLending({ bridge, moving }))); };
    draw(); f.effects[0]!(); await flush(); return draw();
  };
  const AFTER = "It turns on by itself once your bots are on My Cloud.";
  expect(await view(off, true)).toContain(AFTER);
  expect(await view(off, false)).not.toContain(AFTER);
  expect(await view(lent, true)).not.toContain(AFTER);
  const starting = await view({ ...lent, state: { ...lent.state!, connected: false } }, true);
  expect(starting, "on and starting: it says so").not.toContain(AFTER); expect(starting).toContain("Starting…");
  const at = new Date(2026, 9, 7, 14, 2).getTime();
  const yours = await view({ ...off, state: { ...off.state!, stopped: { reason: "you", at } } }, true);
  expect(yours).not.toContain(AFTER); expect(yours).toContain("you turned it off");
  expect(await view({ ...off, state: { ...off.state!, stopped: { reason: "signed-out", at } } }, true)).toContain(AFTER);
});

it("says how it is lent when Computer access lent it, terminal included, and when My Cloud last used it", async () => {
  const viaAccess: CloudLendingSnapshot = { available: true, screenAvailable: true,
    activity: [{ at: Date.now() - 3 * 60_000, server: "My Cloud", origin: "https://omb-u-1.fly.dev", action: "computer_call", detail: "", ok: true }],
    state: { enabled: true, folders: [], screen: true, internet: false, chrome: false, busy: false, via: "access", terminal: true, problem: "access-off" } };
  expect(lendingStatusKey(viaAccess, true)).toBe("lending.status.accessOff");
  await ready(viaAccess);
  const html = render().html;
  expect(html).toContain("Shared through Computer access in Settings → Servers, terminal included.");
  expect(html).toContain("Cloud bots last used this computer 3 minutes ago.");
  await ready({ ...lent, activity: [] });
  expect(render().html).toContain("Cloud bots haven&#x27;t used this computer yet.");
});

it("names a refusal main explains in plain words, and keeps Try again for the rest", () => {
  const ipc = (message: string) => new Error(`Error invoking remote method 'lending:save': Error: ${message}`);
  expect(lendingFailureKey(ipc("lending-refused:home-or-root"))).toBe("lending.refused.homeOrRoot");
  expect(lendingFailureKey(ipc("lending-refused:not-folder"))).toBe("lending.refused.notFolder");
  expect(lendingFailureKey(ipc("lending-refused:too-many"))).toBe("lending.refused.tooMany");
  expect(lendingFailureKey(ipc("lending-refused:something-new"))).toBe("lending.failed");
  expect(lendingFailureKey(ipc("socket hang up"))).toBe("lending.failed");
  expect(lendingFailureKey("not an error")).toBe("lending.failed");
});

it("the words that name other controls name them as the person sees them, in every language", () => {
  // Each sentence, and the labels it must contain exactly: the button below it, and the switch with its Settings place.
  const named: Array<[LocaleKey, LocaleKey[]]> = [
    ["lending.explain", ["lending.more"]],
    ["lending.cloudSide.empty", ["lending.title.computer", "settings.title"]],
    ["computer.worksOnHintCloudHome", ["lending.title.computer", "settings.title"]],
    ["browser.passkey.lendPc", ["lending.title.pc", "settings.title"]],
  ];
  const unseen = localeChoices.flatMap(({ code }) => {
    setLocale(code);
    return named.filter(([sentence]) => code === "en" || Object.hasOwn(locales[code]!, sentence)).flatMap(([sentence, labels]) => labels
      .filter((label) => code === "en" || Object.hasOwn(locales[code]!, label))
      .filter((label) => !t(sentence).includes(t(label))).map((label) => `${code}: ${sentence} does not say "${t(label)}"`));
  });
  setLocale("en");
  expect(unseen).toEqual([]);
});

const terminalBox = () => render().nodes.find(node => node.props["data-lending-terminal-choice"])!;
const withConfirm = (answer: boolean) => { const confirm = vi.fn().mockResolvedValue(answer); vi.stubGlobal("window", { confirm: vi.fn(), ogb: { confirm } }); return confirm; };

it("the terminal is a choice of its own, off by default, that asks before it turns on and is saved only when confirmed", async () => {
  await ready(lent);
  more();
  const html = render().html;
  expect(html).toContain("Terminal");
  expect(html).toContain("run any command on this computer as you");
  expect(terminalBox().props.checked).toBe(false);
  // Declined: nothing is saved and the box stays unticked.
  const declined = withConfirm(false);
  terminalBox().props.onChange!({ target: { checked: true } }); await flush();
  expect(declined).toHaveBeenCalledOnce();
  expect(bridge.save).not.toHaveBeenCalled();
  expect(terminalBox().props.checked).toBe(false);
  // Confirmed: the terminal is named in the save, and nothing else changes.
  const accepted = withConfirm(true);
  terminalBox().props.onChange!({ target: { checked: true } }); await flush();
  expect(accepted).toHaveBeenCalledOnce();
  expect(bridge.save).toHaveBeenCalledExactlyOnceWith({ folders: [folder], screen: false, internet: false, terminal: true });
});

it("a Yes to the terminal question never starts lending again after it was stopped while the question was open", async () => {
  await ready(lent);
  more();
  // Stop sharing (here, or from My Cloud's page) lands while the question is open.
  const confirm = vi.fn(async () => { vi.mocked(bridge.state).mockResolvedValue(off); return true; });
  vi.stubGlobal("window", { confirm: vi.fn(), ogb: { confirm } });
  terminalBox().props.onChange!({ target: { checked: true } }); await flush();
  expect(confirm).toHaveBeenCalledOnce();
  expect(bridge.save).not.toHaveBeenCalled();
  expect(terminalBox().props.checked).toBe(false);
});

it("a Yes to the terminal question lends what is lent now, not what was lent when it was asked", async () => {
  await ready(lent);
  more();
  const other = { ...folder, id: "f2", path: "/Users/me/Projects", name: "Projects" };
  const now: CloudLendingSnapshot = { ...lent, state: { ...lent.state!, folders: [folder, other], screen: true } };
  const confirm = vi.fn(async () => { vi.mocked(bridge.state).mockResolvedValue(now); return true; });
  vi.stubGlobal("window", { confirm: vi.fn(), ogb: { confirm } });
  terminalBox().props.onChange!({ target: { checked: true } }); await flush();
  expect(bridge.save).toHaveBeenCalledExactlyOnceWith({ folders: [folder, other], screen: true, internet: false, terminal: true });
});

it("turning the terminal off needs no question, and it is not kept when lending is switched off and on again", async () => {
  const terminalLent: CloudLendingSnapshot = { ...lent, state: { ...lent.state!, terminal: true } };
  await ready(terminalLent);
  more();
  expect(terminalBox().props.checked).toBe(true);
  expect(render().html).toContain("on this computer");
  const confirm = withConfirm(true);
  terminalBox().props.onChange!({ target: { checked: false } }); await flush();
  expect(confirm).not.toHaveBeenCalled();
  expect(bridge.save).toHaveBeenLastCalledWith({ folders: [folder], screen: false, internet: false });
  // Off, then on: the terminal must be ticked again.
  vi.mocked(bridge.save).mockClear();
  await ready({ ...off, state: { ...off.state!, folders: [folder], terminal: true } });
  toggle().props.onClick!(); await flush();
  expect(bridge.save).toHaveBeenCalledExactlyOnceWith({ folders: [folder], screen: false, internet: false });
});

it("ticking Your Chrome saves it, unticking omits it, and Off then on does not carry it", async () => {
  await ready({ ...lent, state: { ...lent.state!, chrome: true } });
  more();
  const chromeBox = () => render().nodes.find(node => node.props["data-lending-chrome-choice"])!;
  expect(chromeBox().props.checked).toBe(true);
  chromeBox().props.onChange!({ target: { checked: false } }); await flush();
  expect(bridge.save).toHaveBeenLastCalledWith({ folders: [folder], screen: false, internet: false });
  chromeBox().props.onChange!({ target: { checked: true } }); await flush();
  expect(bridge.save).toHaveBeenLastCalledWith({ folders: [folder], screen: false, internet: false, chrome: true });
  vi.mocked(bridge.save).mockClear();
  await ready({ ...off, state: { ...off.state!, folders: [folder], chrome: true } });
  toggle().props.onClick!(); await flush();
  expect(bridge.save).toHaveBeenCalledExactlyOnceWith({ folders: [folder], screen: false, internet: false });
});

it("the Chrome update note shows only when the Cloud cannot take Your Chrome yet", async () => {
  await ready({ ...lent, state: { ...lent.state!, chrome: true, chromeLink: "on" } });
  expect(render().html).not.toContain("My Cloud is updating. Your bots can use your Chrome");
  await ready({ ...lent, state: { ...lent.state!, chrome: true, chromeLink: "unsupported" } });
  expect(render().html).toContain("My Cloud is updating. Your bots can use your Chrome");
});

it("a lent terminal is named in what is lent, in the same words as the Cloud's list", () => {
  expect(lentWhat([], false, false, true)).toBe("terminal");
  expect(lentWhat([], false, true, false, true)).toBe("the internet connection and your Chrome");
  expect(lentWhat([{ name: "Plans", write: true }], true, true, true)).toBe("the internet connection, Plans (can edit), apps and screen, and terminal");
});

it("a terminal lent through Computer access is not carried into what is chosen here: the box starts unticked and a change saves without it", async () => {
  await ready({ ...lent, state: { ...lent.state!, via: "access", terminal: true } });
  more();
  expect(render().html).toContain("terminal included");
  expect(terminalBox().props.checked).toBe(false);
  render().nodes.find(node => node.props["data-lending-internet-choice"])!.props.onChange!({ target: { checked: true } }); await flush();
  expect(bridge.save).toHaveBeenCalledExactlyOnceWith({ folders: [folder], screen: false, internet: true });
});
