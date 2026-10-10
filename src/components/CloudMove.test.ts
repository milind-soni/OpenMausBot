import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState, MoveDestination } from "../../electron/cloud-move.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CloudMoveImport, CloudMoveSettings, CloudMoveSuggestion, moveNextSteps, moveView } from "./CloudMove";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
function render(component: () => ReactNode) {
  f.index = 0; f.effects = []; let tree: ReactNode;
  function Capture() { tree = component(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture)).replaceAll("&#x27;", "'");
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const text = (node: Node) => Children.toArray(node.props.children).join("");
const button = (component: () => ReactNode, label: string) => render(component).nodes.find(node => node.type === "button" && text(node) === label);
const settings = (destination = "cloud") => () => CloudMoveSettings({ destination });
const suggestion = () => CloudMoveSuggestion();
const backups = () => CloudMoveImport();

const CLOUD: MoveDestination = { id: "cloud", name: "My Cloud", origin: "https://omb-u-1a2b3c4d5e6f.fly.dev", kind: "cloud" };
const VPS: MoveDestination = { id: "vps", name: "bots.example.test", origin: "https://bots.example.test", kind: "server" };
let bridge: CloudMoveBridge, push: (state: CloudMoveState) => void, switched: string[];
const local = { bots: 4, rooms: 1, chats: 37, bytes: 1.5 * 1024 ** 3, files: 900, appVersion: "0.1.96", environmentId: "env-here" };
const emptyCloud = { contents: { bots: 1, rooms: 0, chats: 0 }, empty: true, freeBytes: 9 * 1024 ** 3, previous: null, heldBytes: 0 };
const overview = (extra: Partial<CloudMoveOverview> = {}): CloudMoveOverview => ({ phase: "idle", local, cloud: emptyCloud, suggest: false, destination: CLOUD, blocked: null, ...extra });
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = []; push = () => {}; switched = [];
  bridge = {
    state: vi.fn().mockResolvedValue(overview()), start: vi.fn().mockResolvedValue({ phase: "done" }), cancel: vi.fn().mockResolvedValue({ phase: "failed" }),
    restorePrevious: vi.fn().mockResolvedValue({ phase: "done" }), dismiss: vi.fn().mockResolvedValue(overview()),
    onState: vi.fn(callback => { push = callback; return () => {}; }),
  };
  vi.stubGlobal("window", { ogb: { platform: "darwin", cloudMove: bridge, environments: { switch: async (id: string) => { switched.push(id); } } }, location: { reload: vi.fn() } });
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });
async function ready(component: () => ReactNode, state = overview()) {
  vi.mocked(bridge.state).mockResolvedValue(state);
  render(component); f.effects[0](); await flush();
}
const failed = (error: NonNullable<CloudMoveState["error"]>, destination = CLOUD, extra: Partial<CloudMoveState> = {}) =>
  moveView(null, { phase: "failed", action: "move", error, destination, ...extra });

it("Settings → MausBot Cloud: what comes and its size, that sign-ins stay here, and one click that names the Cloud", async () => {
  await ready(settings());
  const { html } = render(settings());
  expect(bridge.state).toHaveBeenCalledWith("cloud");
  expect(html).toContain("Copy this computer's bots and chats");
  expect(html).toContain("from this computer to My Cloud. This computer keeps its own copy.");
  expect(html).toContain("About 1.5 GB: 4 bots, 37 chats, 1 rooms.");
  expect(html).toContain("API keys and sign-ins stay on this computer. On My Cloud you sign in to Claude or ChatGPT");
  expect(html).not.toContain("replaces them");
  button(settings(), "Copy to My Cloud")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.start).mock.calls).toEqual([["cloud"]]);
});

it("Settings → Servers: a self-hosted server with work is replaced only after saying so, backed up first, and swaps back", async () => {
  const server = settings("vps");
  const has = { ...emptyCloud, empty: false, contents: { bots: 3, rooms: 1, chats: 12 } };
  await ready(server, overview({ destination: VPS, cloud: has }));
  let html = render(server).html;
  expect(bridge.state).toHaveBeenCalledWith("vps");
  expect(html).toContain("bots.example.test already has 3 bots and 12 chats. Copying replaces them. They are backed up on bots.example.test first, and Swap bots.example.test back puts them back.");
  expect(button(server, "Copy to bots.example.test")).toBeUndefined();
  expect(button(server, "Swap bots.example.test back")).toBeUndefined();
  button(server, "Replace bots.example.test with this computer's bots and chats")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.start).mock.calls).toEqual([["vps"]]);
  // Swap back keeps one workspace: copying again says, in its one message and
  // on its button, that the backup Swap back would put back now is deleted.
  f.values = []; vi.mocked(bridge.start).mockClear();
  const previous = { createdAt: "2026-09-29T10:00:00.000Z", bots: 2, rooms: 0, chats: 5, bytes: 300 * 1024 ** 2 };
  await ready(server, overview({ destination: VPS, cloud: { ...has, previous } }));
  html = render(server).html;
  const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(previous.createdAt));
  expect(html).toContain(`Copying again replaces bots.example.test's 3 bots and 12 chats. They are backed up on bots.example.test first, in place of its backup from ${date}: that backup is deleted, and Swap bots.example.test back then puts back what bots.example.test has now.`);
  expect(html).not.toContain("already has 3 bots");
  expect(html).toContain("2 bots, 5 chats, 300 MB kept on bots.example.test");
  expect(button(server, "Replace bots.example.test with this computer's bots and chats")).toBeUndefined();
  button(server, `Replace bots.example.test and delete its ${date} backup`)!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.start).mock.calls).toEqual([["vps"]]);
  button(server, "Swap bots.example.test back")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.restorePrevious).mock.calls).toEqual([["vps"]]);
  // Empty now, yet it keeps a backup: copying still deletes it, and says so.
  f.values = [];
  await ready(server, overview({ destination: VPS, cloud: { ...emptyCloud, previous } }));
  expect(render(server).html).toContain(`in place of its backup from ${date}: that backup is deleted`);
});

it("without a session on the Cloud yet, still warns that anything there is replaced and backed up", async () => {
  await ready(settings(), overview({ cloud: null }));
  expect(render(settings()).html).toContain("If My Cloud already has bots or chats, copying replaces them");
});

it("while copying, shows the step and bytes and offers only Stop until the server starts replacing; a copy elsewhere is not shown here", async () => {
  const server = settings("vps");
  await ready(server, overview({ destination: VPS }));
  // Another server's copy: not this one's.
  push({ phase: "uploading", action: "move", destination: CLOUD, progress: { bytesTransferred: 1, totalBytes: 2 } });
  expect(render(server).html).not.toContain("Uploading");
  push({ phase: "uploading", action: "move", destination: VPS, progress: { bytesTransferred: 512 * 1024 ** 2, totalBytes: 1024 ** 3 } });
  let view = render(server);
  expect(view.html).toContain("Uploading to bots.example.test…");
  expect(view.html).toContain("512 MB of 1 GB");
  expect(view.html).toContain("data-cloud-move=\"uploading\"");
  expect(button(server, "Copy to bots.example.test")).toBeUndefined();
  button(server, "Stop the copy")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.cancel).mock.calls).toEqual([[]]);
  push({ phase: "restarting", action: "move", destination: VPS });
  view = render(server);
  expect(view.html).toContain("bots.example.test is restarting…");
  expect(button(server, "Stop the copy")).toBeUndefined();
});

it("reports a full server with both sizes, and continues a stopped upload", async () => {
  await ready(settings("vps"), overview({ destination: VPS }));
  push({ phase: "failed", action: "move", destination: VPS, resumable: true, error: { code: "cloud_full", message: "", freeBytes: 2 * 1024 ** 3, neededBytes: 6 * 1024 ** 3 } });
  const { html } = render(settings("vps"));
  expect(html).toContain("bots.example.test has 2 GB free and this copy needs about 6 GB. Nothing was copied. Make room on bots.example.test");
  expect(html).toContain("What was already uploaded stays on bots.example.test for up to a day");
  button(settings("vps"), "Continue the copy")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.start).mock.calls).toEqual([["vps"]]);
});

it("after a copy: what came, what is not running yet there, and Done", async () => {
  await ready(settings());
  push({ phase: "done", action: "move", destination: CLOUD, moved: { bots: 4, rooms: 1, chats: 37 }, routines: 3 });
  const html = render(settings()).html;
  expect(html).toContain("Copied to My Cloud: 4 bots and 37 chats.");
  expect(html).toContain("Routines arrive paused: 3 were on here. Turn on the ones you want in each bot's Routines tab on My Cloud");
  expect(html).toContain("To use My Cloud from your phone");
  expect(html.indexOf("Copied to My Cloud")).toBeLessThan(html.indexOf("Routines arrive paused: 3"));
  button(settings(), "Done")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.dismiss).mock.calls).toEqual([["cloud"]]);
  expect(moveNextSteps({ phase: "done", action: "move", destination: VPS, moved: { bots: 1, rooms: 0, chats: 1 } })).toEqual([expect.stringContaining("To use bots.example.test from your phone")]);
  expect(moveNextSteps({ phase: "done", action: "restore" })).toEqual([]);
  expect(moveNextSteps({ phase: "failed", action: "move" })).toEqual([]);
});

it("every state reads as one sentence and one next step, for the Cloud and any other server", () => {
  const view = (state: Partial<CloudMoveState>, over: Partial<CloudMoveOverview> | null = null, options = {}) =>
    moveView(over && overview(over), { phase: "idle", ...state } as CloudMoveState, options);
  // Ready.
  expect(view({}, { destination: VPS })).toMatchObject({ server: "bots.example.test", message: null, action: { kind: "start", label: "Copy to bots.example.test" } });
  expect(view({}, { destination: VPS }, { onServerPage: true }).action).toEqual({ kind: "start", label: "Copy" });
  // A server's own page: its Copy opens this computer's Settings on it (main),
  // where Replace is, whatever it holds. The Cloud's own page copies only
  // into an empty Cloud, and says where replacing it is done.
  expect(view({}, { destination: VPS, cloud: { ...emptyCloud, empty: false } }, { onServerPage: true })).toMatchObject({ message: null, action: { kind: "start", label: "Copy" } });
  expect(view({}, { destination: CLOUD, cloud: { ...emptyCloud, empty: false } }, { onServerPage: true })).toMatchObject({
    action: null, message: { tone: "note", text: expect.stringContaining("open Settings → Servers in this computer's window and choose Copy this computer here") } });
  // Blocked before it starts.
  const blocked = (reason: CloudMoveOverview["blocked"], extra: Partial<CloudMoveOverview> = {}) => view({}, { destination: VPS, blocked: reason, ...extra });
  expect(blocked("owner_needed")).toMatchObject({ message: { text: "This app isn't signed in to bots.example.test as its owner. Pair it again with an owner code (openmausbot pair), then copy." }, action: { kind: "open", label: "Open bots.example.test" } });
  expect(blocked("shared_workspace")).toMatchObject({ message: { text: "bots.example.test is shared with other people, so it can't receive this computer's bots and chats. Copy to a server only you use." }, action: null });
  expect(blocked("same_computer")).toMatchObject({ message: { text: "bots.example.test is this computer's own server." }, action: null });
  expect(blocked("outdated", { cloud: { ...emptyCloud, appVersion: "0.1.90" } })).toMatchObject({ message: { text: "bots.example.test runs 0.1.90; this computer runs 0.1.96. Update bots.example.test, then copy again." }, action: { kind: "check", label: "Check again" } });
  expect(blocked("outdated", { cloud: null }).message?.text).toBe("Update OpenMausBot on bots.example.test, then copy again.");
  expect(view({}, { destination: CLOUD, blocked: "outdated", cloud: null }).message?.text).toBe("My Cloud has not updated to a version that can receive a move yet. Try again once it has.");
  expect(blocked("unreachable")).toMatchObject({ message: { text: "bots.example.test didn't answer. Check that it's running, then try again." }, action: { kind: "check" } });
  expect(blocked("busy_elsewhere", { busyWith: "My Cloud" })).toMatchObject({ message: { text: "A copy to My Cloud is running. Wait for it to finish." }, action: null });
  // Failures: what happened, then the one step that can help.
  expect(failed({ code: "restart_timeout", message: "" }, VPS)).toMatchObject({
    message: { tone: "error", text: "bots.example.test hasn't come back yet. If it doesn't start again on its own, start OpenMausBot there; it finishes installing the copy when it starts." },
    action: { kind: "open", label: "Open bots.example.test" } });
  expect(failed({ code: "restart_timeout", message: "" }).message?.text).toBe("My Cloud is taking longer than usual to restart. Check it again in a few minutes.");
  expect(failed({ code: "outdated", message: "", destVersion: "0.1.95", localVersion: "0.1.96" }, VPS)).toMatchObject({
    message: { text: "bots.example.test runs 0.1.95; this computer runs 0.1.96. Update bots.example.test, then copy again." }, action: { kind: "check", label: "Check again" } });
  // One vocabulary: a reason shown before a copy and a copy that failed for it read and act the same.
  for (const [code, extra] of [["owner_needed", {}], ["shared_workspace", {}], ["same_computer", {}], ["unreachable", {}],
    ["outdated", { cloud: { ...emptyCloud, appVersion: "0.1.90" } }], ["busy_elsewhere", { busyWith: "My Cloud" }]] as const) {
    const before = blocked(code, extra);
    const after = failed({ code, message: "", destVersion: "0.1.90", localVersion: "0.1.96", other: "My Cloud" }, VPS);
    expect(after.message?.text, code).toBe(before.message?.text);
    expect(after.action, code).toEqual(before.action);
  }
  // A proxy in front of the server refused even small parts: what to change there, then copy again.
  expect(failed({ code: "proxy_limit", message: "", partBytes: 512 * 1024 }, VPS, { resumable: true })).toMatchObject({
    message: { text: "A proxy in front of bots.example.test refused a 512 KB upload. Raise its request size limit (nginx: client_max_body_size 64m), then copy again." },
    action: { kind: "start", label: "Continue the copy" }, resumable: true });
  expect(failed({ code: "owner_needed", message: "" }, VPS).action?.kind).toBe("open");
  expect(failed({ code: "access_changed", message: "" }, VPS).action?.kind).toBe("open");
  for (const code of ["shared_workspace", "same_computer", "not_empty", "too_large", "cloud_grow_unsupported"]) expect(failed({ code, message: "" }, VPS).action, code).toBeNull();
  expect(failed({ code: "network", message: "" }, VPS)).toMatchObject({ message: { text: "The copy could not reach bots.example.test. Check your connection and try again; it continues where it stopped." }, action: { kind: "start", label: "Copy again" } });
  expect(failed({ code: "upload_failed", message: "" }, VPS, { resumable: true })).toMatchObject({ resumable: true, action: { label: "Continue the copy" } });
  expect(failed({ code: "restore_failed", message: "Wait for bot turns to finish." }, VPS).message?.text)
    .toBe("bots.example.test kept everything it had: Wait for bot turns to finish. What this copy uploaded was removed from bots.example.test.");
  expect(failed({ code: "cancelled", message: "" }).message?.text).toBe("The copy was stopped. Nothing on My Cloud was replaced.");
  expect(failed({ code: "export_failed", message: "A workspace file changed during backup. Stop its writer and retry." }).message?.text)
    .toBe("The copy did not finish: A workspace file changed during backup. Stop its writer and retry.");
  // Under way and done.
  expect(view({ phase: "checking", action: "move", destination: VPS })).toMatchObject({ running: true, message: { tone: "status", text: "bots.example.test is checking the upload…" }, action: { kind: "cancel" } });
  expect(view({ phase: "replacing", action: "restore", destination: VPS })).toMatchObject({ message: { text: "bots.example.test is swapping back to what it had before…" }, action: null });
  expect(view({ phase: "done", action: "restore", destination: VPS })).toMatchObject({ message: { tone: "done", text: "bots.example.test is back to what it had before. What it had just now is kept, so you can swap again." }, action: { kind: "dismiss", label: "Done" } });
});

it("the Cloud's own limits stay the Cloud's: its plan's disk, and growing it", () => {
  const GB = 1024 ** 3;
  expect(failed({ code: "cloud_grow_unavailable", message: "", maxBytes: 100 * GB }).message?.text)
    .toBe("My Cloud's disk grows as it fills, up to 100 GB, but it could not make room for this move just now. Nothing was moved. Try again in a few minutes; if it still can't, tell us through Send Feedback and we'll make room.");
  expect(failed({ code: "cloud_full", message: "", freeBytes: 9 * GB, neededBytes: 11 * GB, maxBytes: 10 * GB }).message?.text)
    .toBe("This move needs about 11 GB of room on My Cloud while it installs, and your plan's disk holds 10 GB. Nothing was moved. A plan with a larger disk can take it: see your Plan page.");
  // The plan's disk would hold it; what is on the Cloud is in the way: make room, never "a larger plan".
  expect(failed({ code: "cloud_full", message: "", freeBytes: 15 * GB, neededBytes: 19.8 * GB, maxBytes: 50 * GB }).message?.text)
    .toBe("My Cloud has 15 GB free and this copy needs about 19.8 GB. Nothing was copied. Make room on My Cloud (for example, remove large files there), then try again.");
  const largest = failed({ code: "cloud_full", message: "", freeBytes: 90 * GB, neededBytes: 120 * GB, maxBytes: 100 * GB, largest: true }).message!.text;
  expect(largest).toContain("the largest there is"); expect(largest).toContain("Send Feedback"); expect(largest).not.toContain("larger disk");
  const unsupported = failed({ code: "cloud_grow_unsupported", message: "", freeBytes: 9 * GB, neededBytes: 20 * GB, maxBytes: 100 * GB }).message!.text;
  expect(unsupported).toBe("This move needs about 20 GB of room on My Cloud while it installs, more than My Cloud can make room for yet. Nothing was moved. Tell us through Send Feedback and we'll make room.");
  expect(failed({ code: "cloud_grow_unsupported", message: "" }).message?.text).not.toMatch(/try again/i);
  // Today's Admin (no disk word): more than the Cloud's whole disk is not "remove files"; less is.
  expect(failed({ code: "cloud_full", message: "", freeBytes: 8.9 * GB, neededBytes: 10.5 * GB, volumeBytes: 10 * GB }).message?.text).toBe(unsupported.replace("20 GB", "10.5 GB"));
  expect(failed({ code: "cloud_full", message: "", freeBytes: 2 * GB, neededBytes: 5 * GB, volumeBytes: 10 * GB }).message?.text).toContain("Make room on My Cloud");
  // A self-hosted disk never "grows": more than it holds is "make room" there.
  expect(failed({ code: "cloud_full", message: "", freeBytes: 8.9 * GB, neededBytes: 10.5 * GB, volumeBytes: 10 * GB }, VPS).message?.text).toContain("Make room on bots.example.test");
  // Before it starts: a copy that cannot fit says so, with the next step, and offers no button.
  const fit = (value: CloudMoveOverview["fit"]) => moveView(overview({ fit: value }), { phase: "idle" });
  expect(fit({ fit: "never", neededBytes: 19.8 * GB, freeBytes: 15 * GB, maxBytes: 50 * GB })).toMatchObject({ message: { tone: "note", text: expect.not.stringContaining("larger disk") }, action: null });
  expect(fit({ fit: "never", neededBytes: 10.5 * GB, freeBytes: 8.9 * GB, volumeBytes: 10 * GB }).message?.text).toContain("Tell us through Send Feedback");
  expect(fit({ fit: "never", neededBytes: 120 * GB, freeBytes: 90 * GB, maxBytes: 100 * GB, largest: true }).message?.text).toContain("the largest there is");
  expect(fit({ fit: "grow", neededBytes: 11 * GB, freeBytes: 9 * GB, maxBytes: 100 * GB, sizeGb: 20 })).toMatchObject({ message: null, action: { kind: "start", label: "Copy to My Cloud" } });
});

it("the next step opens the server: from Settings it switches this window to it, on its own page it loads again", async () => {
  await ready(settings("vps"), overview({ destination: VPS, blocked: "owner_needed" }));
  button(settings("vps"), "Open bots.example.test")!.props.onClick!(); await flush();
  expect(switched).toEqual(["vps"]);
  f.values = [];
  await ready(backups, overview({ destination: VPS, blocked: "owner_needed" }));
  button(backups, "Open bots.example.test")!.props.onClick!(); await flush();
  expect(window.location.reload).toHaveBeenCalledOnce();
});

it("is not offered to a companion connected to another computer", async () => {
  vi.stubGlobal("window", { ogb: { cloudMove: bridge, remoteClient: { active: true } } });
  for (const component of [settings(), backups]) {
    f.values = [];
    render(component);
    expect(f.effects).toHaveLength(1);
    f.effects[0]();
    expect(render(component).html).toBe("");
  }
  expect(bridge.state).not.toHaveBeenCalled();
});

it("the card on an empty server shows only when main suggests it, names the server, and says Mac on a Mac", async () => {
  await ready(suggestion, overview({ destination: VPS }));
  expect(render(suggestion).html).toBe("");
  expect(vi.mocked(bridge.state).mock.calls).toEqual([[undefined]]);
  f.values = [];
  await ready(suggestion, overview({ destination: VPS, suggest: true }));
  const { html } = render(suggestion);
  expect(html).toContain("Bring your bots and chats from this Mac");
  expect(html).toContain("bots.example.test is empty. Copy 4 bots and 37 chats here (about 1.5 GB).");
  expect(button(suggestion, "Copy")).toBeTruthy();
  expect(button(suggestion, "Not now")).toBeTruthy();
});

it("the card copies on Copy and keeps showing it; Not now hides it for good; after a copy it says what came until Done", async () => {
  await ready(suggestion, overview({ destination: VPS, suggest: true }));
  button(suggestion, "Copy")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.start).mock.calls).toEqual([[undefined]]);
  push({ phase: "uploading", action: "move", destination: VPS, progress: { bytesTransferred: 1, totalBytes: 2 } });
  vi.mocked(bridge.state).mockResolvedValue(overview({ destination: VPS, suggest: false, phase: "uploading" }));
  expect(render(suggestion).html).toContain("Uploading to bots.example.test");

  f.values = []; f.effects = [];
  vi.stubGlobal("window", { ogb: { platform: "win32", cloudMove: bridge } });
  await ready(suggestion, overview({ destination: VPS, suggest: true }));
  expect(render(suggestion).html).toContain("Bring your bots and chats from this computer");
  button(suggestion, "Not now")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.dismiss).mock.calls).toEqual([[undefined]]);
  expect(render(suggestion).html).toBe("");

  // Opened again after a copy started in this computer's Settings: what came, until Done.
  f.values = []; f.effects = []; vi.mocked(bridge.dismiss).mockClear();
  await ready(suggestion, overview({ destination: VPS, phase: "done", action: "move", moved: { bots: 4, rooms: 1, chats: 37 }, routines: 2 }));
  const done = render(suggestion).html;
  expect(done).toContain("Copied to bots.example.test: 4 bots and 37 chats.");
  expect(done).toContain("Routines arrive paused: 2 were on here.");
  expect(button(suggestion, "Not now")).toBeUndefined();
  vi.mocked(bridge.dismiss).mockResolvedValue(overview({ destination: VPS, cloud: { ...emptyCloud, empty: false } }));
  button(suggestion, "Done")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.dismiss).mock.calls).toEqual([[undefined]]);
  expect(render(suggestion).html).toBe("");
});

it("Settings → Backups on a server: Import from this computer is the same copy, and is hidden where it cannot happen", async () => {
  // This computer's own page (no server named) and a browser: nothing.
  await ready(backups, overview({ destination: null }));
  expect(render(backups).html).toBe("");
  for (const reason of ["shared_workspace", "same_computer"] as const) {
    f.values = [];
    await ready(backups, overview({ destination: VPS, blocked: reason }));
    expect(render(backups).html, reason).toBe("");
  }
  // An empty server open in this window: the offer, beside the file import.
  f.values = [];
  await ready(backups, overview({ destination: VPS }));
  const { html } = render(backups);
  expect(vi.mocked(bridge.state).mock.calls.at(-1)).toEqual([undefined]);
  expect(html).toContain("Import from this computer");
  expect(html).toContain("no file or password");
  expect(html).toContain("bots.example.test is empty. Copy 4 bots and 37 chats here (about 1.5 GB).");
  expect(button(backups, "Not now")).toBeUndefined();
  button(backups, "Copy")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.start).mock.calls).toEqual([[undefined]]);
  push({ phase: "uploading", action: "move", destination: VPS, progress: { bytesTransferred: 1, totalBytes: 2 } });
  expect(render(backups).html).toContain("Uploading to bots.example.test…");
  // A server with work: the same Copy (main opens this computer's Settings on
  // it, where Replace is), never "is empty".
  f.values = []; vi.mocked(bridge.start).mockClear();
  await ready(backups, overview({ destination: VPS, cloud: { ...emptyCloud, empty: false } }));
  expect(render(backups).html).not.toContain("is empty");
  expect(render(backups).html).toContain("from this computer to bots.example.test");
  button(backups, "Copy")!.props.onClick!(); await flush();
  expect(vi.mocked(bridge.start).mock.calls).toEqual([[undefined]]);
  // The Cloud with work: its own page does not copy over it, and says where that is done.
  f.values = [];
  await ready(backups, overview({ destination: CLOUD, cloud: { ...emptyCloud, empty: false } }));
  expect(render(backups).html).toContain("open Settings → Servers in this computer's window");
  expect(button(backups, "Copy")).toBeUndefined();
  // No desktop bridge (a browser): nothing, and nothing asked.
  f.values = []; vi.mocked(bridge.state).mockClear();
  vi.stubGlobal("window", { ogb: {} });
  render(backups); f.effects[0]?.();
  expect(render(backups).html).toBe("");
  expect(bridge.state).not.toHaveBeenCalled();
});
