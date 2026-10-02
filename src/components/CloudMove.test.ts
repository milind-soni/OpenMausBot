import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CloudMoveSettings, CloudMoveSuggestion, cloudMoveErrorText, moveFitNote, moveNextSteps } from "./CloudMove";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
function render(component: () => ReactNode) {
  f.index = 0; f.effects = []; let tree: ReactNode;
  function Capture() { tree = component(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const text = (node: Node) => Children.toArray(node.props.children).join("");
const button = (component: () => ReactNode, label: string) => render(component).nodes.find(node => node.type === "button" && text(node) === label);
const settings = () => CloudMoveSettings();
const suggestion = () => CloudMoveSuggestion();

let bridge: CloudMoveBridge, push: (state: CloudMoveState) => void;
const local = { bots: 4, rooms: 1, chats: 37, bytes: 1.5 * 1024 ** 3, files: 900 };
const emptyCloud = { contents: { bots: 1, rooms: 0, chats: 0 }, empty: true, freeBytes: 9 * 1024 ** 3, previous: null, heldBytes: 0 };
const overview = (extra: Partial<CloudMoveOverview> = {}): CloudMoveOverview => ({ phase: "idle", local, cloud: emptyCloud, suggest: false, ...extra });
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = []; push = () => {};
  bridge = {
    state: vi.fn().mockResolvedValue(overview()), start: vi.fn().mockResolvedValue({ phase: "done" }), cancel: vi.fn().mockResolvedValue({ phase: "failed" }),
    restorePrevious: vi.fn().mockResolvedValue({ phase: "done" }), dismiss: vi.fn().mockResolvedValue(overview()),
    onState: vi.fn(callback => { push = callback; return () => {}; }),
  };
  vi.stubGlobal("window", { ogb: { platform: "darwin", cloudMove: bridge } }); setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });
async function ready(component: () => ReactNode, state = overview()) {
  vi.mocked(bridge.state).mockResolvedValue(state);
  render(component); f.effects[0](); await flush();
}

it("before a move, shows what moves and its size, that sign-ins stay here, and starts with one click sending nothing", async () => {
  await ready(settings);
  const { html } = render(settings);
  expect(html).toContain("Move to Cloud");
  expect(html).toContain("About 1.5 GB: 4 bots, 37 chats, 1 rooms.");
  expect(html).toContain("API keys and sign-ins stay on this computer");
  expect(html).toContain("sign in to Claude or ChatGPT");
  expect(html).not.toContain("replaces them");
  button(settings, "Move to Cloud")!.props.onClick!(); await flush();
  expect(bridge.start).toHaveBeenCalledExactlyOnceWith();
});

it("says plainly that a Cloud with work is replaced, backed up first, and can be swapped back", async () => {
  const previous = { createdAt: "2026-09-29T10:00:00.000Z", bots: 2, rooms: 0, chats: 5, bytes: 300 * 1024 ** 2 };
  await ready(settings, overview({ cloud: { ...emptyCloud, empty: false, contents: { bots: 3, rooms: 1, chats: 12 }, previous } }));
  const { html } = render(settings);
  expect(html).toContain("Your Cloud already has 3 bots and 12 chats. Moving replaces them. They are backed up on your Cloud first");
  expect(button(settings, "Move to Cloud")).toBeUndefined();
  expect(button(settings, "Replace my Cloud with this computer&#x27;s bots and chats") ?? button(settings, "Replace my Cloud with this computer's bots and chats")).toBeTruthy();
  expect(html).toContain("2 bots, 5 chats, 300 MB kept on your Cloud");
  expect(html).toContain("What your Cloud has now is kept as the previous Cloud instead, so you can swap again.");
  button(settings, "Swap back to previous Cloud")!.props.onClick!(); await flush();
  expect(bridge.restorePrevious).toHaveBeenCalledExactlyOnceWith();
  expect(bridge.start).not.toHaveBeenCalled();
});

it("without a session on the Cloud yet, still warns that anything there is replaced and backed up", async () => {
  await ready(settings, overview({ cloud: null }));
  expect(render(settings).html).toContain("If your Cloud already has bots or chats, moving replaces them");
});

it("while moving, shows the step and bytes and offers only Stop until the Cloud starts replacing", async () => {
  await ready(settings);
  push({ phase: "uploading", action: "move", progress: { bytesTransferred: 512 * 1024 ** 2, totalBytes: 1024 ** 3 } });
  let view = render(settings);
  expect(view.html).toContain("Uploading to your Cloud");
  expect(view.html).toContain("512 MB of 1 GB");
  expect(view.html).toContain("data-cloud-move=\"uploading\"");
  expect(button(settings, "Move to Cloud")).toBeUndefined();
  expect(button(settings, "Swap back to previous Cloud")).toBeUndefined();
  button(settings, "Stop the move")!.props.onClick!(); await flush();
  expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith();
  push({ phase: "restarting", action: "move" });
  view = render(settings);
  expect(view.html).toContain("Your Cloud is restarting");
  expect(button(settings, "Stop the move")).toBeUndefined();
});

it("reports a full Cloud with both sizes, and continues a stopped upload", async () => {
  await ready(settings);
  push({ phase: "failed", action: "move", resumable: true, error: { code: "cloud_full", message: "", freeBytes: 2 * 1024 ** 3, neededBytes: 6 * 1024 ** 3 } });
  const { html } = render(settings);
  expect(html).toContain("Your Cloud has 2 GB free and this move needs about 6 GB. Nothing was moved. Make room on your Cloud");
  expect(button(settings, "Continue the move")).toBeTruthy();
  expect(html).toContain("What was already uploaded stays on your Cloud for up to a day");
  expect(cloudMoveErrorText({ code: "restore_failed", message: "Wait for bot turns to finish." }))
    .toBe("Your Cloud kept everything it had: Wait for bot turns to finish. What this move uploaded was removed from your Cloud.");
  expect(cloudMoveErrorText({ code: "cancelled", message: "" })).toBe("The move was stopped. Nothing on your Cloud was replaced.");
  expect(cloudMoveErrorText({ code: "export_failed", message: "A workspace file changed during backup. Stop its writer and retry." }))
    .toBe("The move did not finish: A workspace file changed during backup. Stop its writer and retry.");
});

it("reports what was moved when it is done, then what is not running yet there, and the phone", async () => {
  await ready(settings);
  push({ phase: "done", action: "move", moved: { bots: 4, rooms: 1, chats: 37 }, routines: 3 });
  const html = render(settings).html;
  expect(html).toContain("Moved to your Cloud: 4 bots and 37 chats.");
  expect(html).toContain("Routines arrive paused: 3 were on here. Turn on the ones you want in each bot");
  expect(html).toContain("so nothing runs twice");
  expect(html).toContain("Your phone is still paired with this computer");
  expect(html.indexOf("Moved to your Cloud")).toBeLessThan(html.indexOf("Routines arrive paused: 3"));
  // No routines on here: only the phone. A swap back is not a move.
  expect(moveNextSteps({ phase: "done", action: "move", moved: { bots: 1, rooms: 0, chats: 1 } })).toEqual([expect.stringContaining("Your phone")]);
  expect(moveNextSteps({ phase: "done", action: "restore" })).toEqual([]);
  expect(moveNextSteps({ phase: "failed", action: "move" })).toEqual([]);
});

it("a plan whose disk grows makes room first; a move that cannot fit says so before it starts, with the next step", async () => {
  await ready(settings);
  push({ phase: "growing", action: "move" });
  let html = render(settings).html;
  expect(html).toContain("Making room on your Cloud for this move…"); expect(button(settings, "Stop the move")).toBeTruthy();
  expect(cloudMoveErrorText({ code: "cloud_grow_unavailable", message: "", maxBytes: 100 * 1024 ** 3 }))
    .toBe("Your Cloud's disk grows as it fills, up to 100 GB, but it could not make room for this move just now. Nothing was moved. Try again in a few minutes; if it still can't, tell us through Send Feedback and we'll make room.");
  expect(cloudMoveErrorText({ code: "cloud_full", message: "", freeBytes: 9 * 1024 ** 3, neededBytes: 11 * 1024 ** 3, maxBytes: 10 * 1024 ** 3 }))
    .toBe("This move needs about 11 GB of room on your Cloud while it installs, and your plan's disk holds 10 GB. Nothing was moved. A plan with a larger disk can take it: see your Cloud dashboard.");
  // The plan's disk would hold it; what is on the Cloud is in the way: make room, never "a larger plan".
  const GB = 1024 ** 3;
  const used = cloudMoveErrorText({ code: "cloud_full", message: "", freeBytes: 15 * GB, neededBytes: 19.8 * GB, maxBytes: 50 * GB });
  expect(used).toBe("Your Cloud has 15 GB free and this move needs about 19.8 GB. Nothing was moved. Make room on your Cloud (for example, remove large files there), then try again.");
  // The largest plan is never pointed at a larger one.
  const largest = cloudMoveErrorText({ code: "cloud_full", message: "", freeBytes: 90 * GB, neededBytes: 120 * GB, maxBytes: 100 * GB, largest: true });
  expect(largest).toContain("the largest there is"); expect(largest).toContain("Send Feedback"); expect(largest).not.toContain("larger disk");
  // An Admin that cannot grow the disk for a move: no "try again" that cannot work.
  const unsupported = cloudMoveErrorText({ code: "cloud_grow_unsupported", message: "", freeBytes: 9 * GB, neededBytes: 20 * GB, maxBytes: 100 * GB });
  expect(unsupported).toBe("This move needs about 20 GB of room on your Cloud while it installs, more than your Cloud can make room for yet. Nothing was moved. Tell us through Send Feedback and we'll make room.");
  expect(cloudMoveErrorText({ code: "cloud_grow_unsupported", message: "" })).not.toMatch(/try again/i);
  // Today's Admin (no disk word): more than the Cloud's whole disk is not "remove files"; less is.
  expect(cloudMoveErrorText({ code: "cloud_full", message: "", freeBytes: 8.9 * GB, neededBytes: 10.5 * GB, volumeBytes: 10 * GB })).toBe(unsupported.replace("20 GB", "10.5 GB"));
  expect(cloudMoveErrorText({ code: "cloud_full", message: "", freeBytes: 2 * GB, neededBytes: 5 * GB, volumeBytes: 10 * GB })).toContain("Make room on your Cloud");
  expect(moveFitNote(overview({ fit: { fit: "never", neededBytes: 19.8 * GB, freeBytes: 15 * GB, maxBytes: 50 * GB } }))).not.toContain("larger disk");
  expect(moveFitNote(overview({ fit: { fit: "never", neededBytes: 10.5 * GB, freeBytes: 8.9 * GB, volumeBytes: 10 * GB } }))).toContain("Tell us through Send Feedback");
  expect(moveFitNote(overview({ fit: { fit: "never", neededBytes: 120 * GB, freeBytes: 90 * GB, maxBytes: 100 * GB, largest: true } }))).toContain("the largest there is");
  f.values = []; push = () => {};
  await ready(settings, overview({ fit: { fit: "never", neededBytes: 11 * 1024 ** 3, freeBytes: 9 * 1024 ** 3, maxBytes: 10 * 1024 ** 3 } }));
  html = render(settings).html; expect(html).toContain("disk holds 10 GB. Nothing was moved.");
  f.values = [];
  await ready(settings, overview({ fit: { fit: "grow", neededBytes: 11 * 1024 ** 3, freeBytes: 9 * 1024 ** 3, maxBytes: 100 * 1024 ** 3, sizeGb: 20 } }));
  html = render(settings).html; expect(html).not.toContain("Nothing was moved"); expect(button(settings, "Move to Cloud")).toBeTruthy();
});

it("is not offered to a companion connected to another computer", async () => {
  vi.stubGlobal("window", { ogb: { cloudMove: bridge, remoteClient: { active: true } } });
  render(settings);
  expect(f.effects).toHaveLength(1);
  f.effects[0]();
  expect(bridge.state).not.toHaveBeenCalled();
  expect(render(settings).html).toBe("");
});

it("the card on an empty Cloud shows only when main suggests it, and says Mac on a Mac", async () => {
  await ready(suggestion);
  expect(render(suggestion).html).toBe("");
  await ready(suggestion, overview({ suggest: true }));
  const { html } = render(suggestion);
  expect(html).toContain("Bring your bots and chats from this Mac");
  expect(html).toContain("Your Cloud is empty. Move 4 bots and 37 chats here (about 1.5 GB).");
  expect(button(suggestion, "Move")).toBeTruthy();
  expect(button(suggestion, "Not now")).toBeTruthy();
});

it("the card moves on Move and keeps showing the move; Not now hides it for good", async () => {
  await ready(suggestion, overview({ suggest: true }));
  button(suggestion, "Move")!.props.onClick!(); await flush();
  expect(bridge.start).toHaveBeenCalledExactlyOnceWith();
  push({ phase: "uploading", action: "move", progress: { bytesTransferred: 1, totalBytes: 2 } });
  vi.mocked(bridge.state).mockResolvedValue(overview({ suggest: false, phase: "uploading" }));
  expect(render(suggestion).html).toContain("Uploading to your Cloud");

  f.values = []; f.effects = [];
  vi.stubGlobal("window", { ogb: { platform: "win32", cloudMove: bridge } });
  await ready(suggestion, overview({ suggest: true }));
  expect(render(suggestion).html).toContain("Bring your bots and chats from this computer");
  button(suggestion, "Not now")!.props.onClick!(); await flush();
  expect(bridge.dismiss).toHaveBeenCalledExactlyOnceWith();
  expect(render(suggestion).html).toBe("");
});
