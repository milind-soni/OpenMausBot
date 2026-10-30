// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CloudFilesBridge, CloudFilesState, FolderCheck, SharedFolder } from "../../electron/cloud-sync.mjs";
import { setLocale } from "@/lib/i18n";
import { BotEditorStore, initialState, type useStore } from "@/state/store";
import { FilesView } from "./FilesView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const GB = 1024 ** 3;
const folder = (status: SharedFolder["status"], extra: Partial<SharedFolder> = {}): SharedFolder =>
  ({ id: `f-${status}`, name: `Folder ${status}`, pcPath: `/Users/ada/${status}`, status, files: 1200, done: 400, waitingBytes: 0, pendingDeletes: 3, problem: null, ...extra });
const base: CloudFilesState = { phase: "idle", lastSyncedAt: 1, disk: null, shared: [], outputs: { enabled: false, dir: "/Users/ada/Documents/MausBot", folders: 0, problem: null } };
const check = (name: string, extra: Partial<FolderCheck> = {}): FolderCheck =>
  ({ token: `t-${name}`, name, pcPath: `/Users/ada/${name}`, files: 120, bytes: 3 * 1024 ** 2, partial: false, refusal: null, ...extra });

type FakeBridge = { [K in keyof CloudFilesBridge]: Mock<CloudFilesBridge[K]> };
let host: HTMLDivElement, root: Root, bridge: FakeBridge, emit: (state: CloudFilesState) => void;
const off = vi.fn(), dispatch = vi.fn();
async function mount(state: CloudFilesState = base, filesSuggest: string[] | null = null) {
  act(() => root.unmount());
  root = createRoot(host);
  bridge.state.mockResolvedValue(state);
  const store = { state: { ...initialState, filesSuggest }, dispatch } as unknown as ReturnType<typeof useStore>;
  await act(async () => root.render(createElement(BotEditorStore, { value: store, children: createElement(FilesView) })));
}
const page = () => document.body.textContent ?? "";
const buttons = (scope: ParentNode = document.body) => Array.from(scope.querySelectorAll("button"));
const button = (label: string, scope: ParentNode = document.body) =>
  buttons(scope).find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
const click = (label: string, scope?: ParentNode) => act(async () => {
  const target = button(label, scope);
  if (!target) throw new Error(`no button ${label}`);
  target.click();
});
const row = (status: string) => document.querySelector<HTMLElement>(`[data-files-folder="${status}"]`)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');

beforeEach(() => {
  setLocale("en");
  dispatch.mockReset(); off.mockReset();
  bridge = {
    state: vi.fn(), onState: vi.fn((callback) => { emit = callback; return off; }),
    pickFolder: vi.fn(), checkFolders: vi.fn(), share: vi.fn().mockResolvedValue(base), stopSharing: vi.fn().mockResolvedValue(base),
    answerDeletes: vi.fn().mockResolvedValue(base), locate: vi.fn().mockResolvedValue(base), setOutputs: vi.fn().mockResolvedValue(base),
    open: vi.fn().mockResolvedValue(undefined), moreSpace: vi.fn().mockResolvedValue(undefined),
  };
  window.ogb = { cloudAccount: { files: bridge } } as unknown as typeof window.ogb;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.replaceChildren(); delete window.ogb; });

describe("Shared with the Cloud", () => {
  it("says what sharing does, shows nothing shared yet, and always offers Add a folder", async () => {
    await mount();
    expect(page()).toContain("Files");
    expect(page()).toContain("Cloud bots can use these folders, even when this computer is off. They change files here only in folders you let them edit.");
    expect(page()).toContain("Nothing shared yet.");
    expect(button("Add a folder")).toBeTruthy();
    expect(page()).not.toMatch(/sync/i);
  });

  it("gives each folder one status line, with the next step only where one is needed", async () => {
    await mount({ ...base, shared: [folder("synced"), folder("copying"), folder("waiting"), folder("confirm-deletes"), folder("missing"), folder("problem", { problem: "My Cloud's disk had an error." })] });
    expect(row("synced").textContent).toContain("Up to date");
    expect(row("copying").textContent).toContain("Copying… 400 of 1,200");
    expect(row("waiting").textContent).toContain("Waiting for room in the Cloud");
    expect(row("confirm-deletes").textContent).toContain("3 files were removed from this folder here. Remove them from the Cloud too?");
    expect(row("missing").textContent).toContain("Can't find this folder. Was it moved?");
    expect(row("problem").textContent).toContain("My Cloud's disk had an error.");
    for (const status of ["synced", "copying", "problem"]) expect(buttons(row(status)).map((node) => node.getAttribute("aria-label"))).toEqual([`More for Folder ${status}`]);
    await click("Get more space", row("waiting"));
    expect(bridge.moreSpace).toHaveBeenCalledOnce();
    await click("Keep them", row("confirm-deletes"));
    expect(bridge.answerDeletes).toHaveBeenLastCalledWith("f-confirm-deletes", false);
    await mount({ ...base, shared: [folder("confirm-deletes", { pendingDeletes: 1 }), folder("missing")] });
    expect(row("confirm-deletes").textContent).toContain("1 file was removed from this folder here. Remove it from the Cloud too?");
    await click("Remove from the Cloud", row("confirm-deletes"));
    expect(bridge.answerDeletes).toHaveBeenLastCalledWith("f-confirm-deletes", true);
  });

  it("says in its one line, for a week, when a bot's change met the person's own: both kept, and where", async () => {
    const kept = [{ path: "todo.md", beside: "todo (new from My Cloud, 27 Oct 2026).md", at: Date.now() - 60_000 }];
    await mount({ ...base, shared: [folder("synced", { lent: true, kept })] });
    expect(row("synced").textContent).toContain("Kept both versions of “todo.md”: yours, and the bot's as “todo (new from My Cloud, 27 Oct 2026).md”.");
    expect(row("synced").textContent).not.toContain("Up to date");
    await mount({ ...base, shared: [folder("synced", { lent: true, kept: [{ ...kept[0]!, at: Date.now() - 8 * 24 * 60 * 60_000 }] })] });
    expect(row("synced").textContent).toContain("Up to date");
    // Something to do comes first.
    await mount({ ...base, shared: [folder("missing", { lent: true, kept })] });
    expect(row("missing").textContent).toContain("Can't find this folder. Was it moved?");
  });

  it("finds a moved folder, or stops sharing it after saying what that does", async () => {
    bridge.locate.mockResolvedValue({ ...base, shared: [folder("missing")] });
    await mount({ ...base, shared: [folder("missing")] });
    await click("Find it", row("missing"));
    expect(bridge.locate).toHaveBeenCalledWith("f-missing");
    await click("Stop sharing", row("missing"));
    expect(dialog()?.textContent).toContain("Stop sharing “Folder missing”?");
    expect(dialog()?.textContent).toContain("The Cloud's copy moves to its trash for 30 days. Nothing on this computer changes.");
    await click("Cancel", dialog()!);
    expect(dialog()).toBeNull();
    expect(bridge.stopSharing).not.toHaveBeenCalled();
    await click("Stop sharing", row("missing"));
    await click("Stop sharing", dialog()!);
    expect(bridge.stopSharing).toHaveBeenCalledExactlyOnceWith("f-missing");
    expect(page()).toContain("Nothing shared yet.");
  });

  it("the ⋯ menu opens the folder here or stops sharing it", async () => {
    await mount({ ...base, shared: [folder("synced")] });
    await click("More for Folder synced");
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((node) => node.textContent)).toEqual(["Open on this computer", "Stop sharing"]);
    await click("Open on this computer");
    expect(bridge.open).toHaveBeenCalledWith({ folderId: "f-synced" });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click("More for Folder synced");
    await act(async () => (document.querySelector('[role="menuitem"]:last-child') as HTMLElement).click());
    expect(dialog()?.textContent).toContain("Stop sharing “Folder synced”?");
  });

  it("shows how full My Cloud is, and offers more space when it is almost full", async () => {
    const disk = { totalBytes: 10 * GB, freeBytes: 6 * GB, usedBytes: 4 * GB, sharedBytes: GB, warn: false };
    await mount({ ...base, disk });
    expect(page()).toContain("4 GB of 10 GB used in the Cloud");
    expect(page()).not.toContain("almost full");
    await act(async () => emit({ ...base, disk: { ...disk, usedBytes: 9 * GB, freeBytes: GB, warn: true } }));
    expect(page()).toContain("9 GB of 10 GB used in the Cloud");
    expect(page()).toContain("The Cloud is almost full.");
    await click("Get more space");
    expect(bridge.moreSpace).toHaveBeenCalledOnce();
  });
});

describe("Add a folder", () => {
  it("does nothing when the picker is cancelled", async () => {
    bridge.pickFolder.mockResolvedValue(null);
    await mount();
    await click("Add a folder");
    expect(bridge.pickFolder).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(bridge.share).not.toHaveBeenCalled();
  });

  it("asks before sharing, with the folder's size, and shares its token", async () => {
    bridge.pickFolder.mockResolvedValue(check("Plans"));
    bridge.share.mockResolvedValue({ ...base, shared: [folder("copying", { name: "Plans" })] });
    await mount();
    await click("Add a folder");
    expect(dialog()?.textContent).toContain("Share “Plans” with the Cloud?");
    expect(dialog()?.textContent).toContain("120 files · 3 MB. The Cloud keeps a copy and updates it when you change files here. Cloud bots can read it.");
    await click("Cancel", dialog()!);
    expect(bridge.share).not.toHaveBeenCalled();
    bridge.pickFolder.mockResolvedValue(check("Plans", { files: 50_000, partial: true }));
    await click("Add a folder");
    expect(dialog()?.textContent).toContain("More than 50,000 files · 3 MB.");
    await click("Share", dialog()!);
    expect(bridge.share).toHaveBeenCalledExactlyOnceWith("t-Plans");
    expect(dialog()).toBeNull();
    expect(row("copying").textContent).toContain("Plans");
  });

  it.each([
    ["too-broad", "That folder is too big to share. Choose a folder inside it, like one in Documents."],
    ["app-data", "That's MausBot's own folder. Choose another one."],
    ["already-shared", "This folder is already shared."],
    ["not-a-folder", "Choose a folder."],
    ["private", "That folder holds private keys or settings, so it isn't shared. Choose another one."],
  ] as const)("a refused folder (%s) gets one plain sentence and only OK", async (refusal, sentence) => {
    bridge.pickFolder.mockResolvedValue(check("Home", { refusal: refusal as FolderCheck["refusal"] }));
    await mount();
    await click("Add a folder");
    expect(dialog()?.textContent).toBe(`${sentence}OK`);
    expect(buttons(dialog()!).map((node) => node.textContent)).toEqual(["OK"]);
    await click("OK", dialog()!);
    expect(dialog()).toBeNull();
    expect(bridge.share).not.toHaveBeenCalled();
  });

  it("says plainly when main refuses, without a stack", async () => {
    bridge.pickFolder.mockResolvedValue(check("Plans"));
    bridge.share.mockRejectedValue(new Error("Error invoking remote method 'files:share': Error: My Cloud is full.\n    at share (cloud-sync.mjs:1:1)"));
    await mount();
    await click("Add a folder");
    await click("Share", dialog()!);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("That didn't work: My Cloud is full.");
    bridge.pickFolder.mockRejectedValue(new Error(""));
    await click("Add a folder");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("That didn't work. Try again.");
  });
});

describe("folders a move to My Cloud left here", () => {
  it("checks the suggested folders, asks once with each one ticked, and shares only the ticked ones", async () => {
    bridge.checkFolders.mockResolvedValue([check("site"), check("notes", { files: 1, bytes: 2048 }), check("x.docx", { refusal: "not-a-folder" }), check("Home", { refusal: "too-broad" })]);
    await mount(base, ["/Users/ada/site", "/Users/ada/notes", "/Users/ada/x.docx", "/Users/ada"]);
    expect(bridge.checkFolders).toHaveBeenCalledExactlyOnceWith(["/Users/ada/site", "/Users/ada/notes", "/Users/ada/x.docx", "/Users/ada"]);
    const shown = dialog()!;
    expect(shown.textContent).toContain("Share these folders with the Cloud?");
    expect(shown.textContent).toContain("120 files · 3 MB");
    expect(shown.textContent).toContain("1 file · 2 KB");
    expect(shown.textContent).toContain("Not a folder on this computer.");
    expect(shown.textContent).toContain("That folder is too big to share.");
    const boxes = Array.from(shown.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([[true, false], [true, false], [false, true], [false, true]]);
    await act(async () => boxes[1]!.click());
    await click("Share", shown);
    expect(bridge.share.mock.calls).toEqual([["t-site"]]);
    expect(dialog()).toBeNull();
  });

  it("asks nothing until The Cloud is ready, and nothing without suggestions", async () => {
    await mount({ ...base, phase: "unavailable" }, ["/Users/ada/site"]);
    expect(bridge.checkFolders).not.toHaveBeenCalled();
    await mount();
    expect(bridge.checkFolders).not.toHaveBeenCalled();
  });
});

describe("Your bots' work", () => {
  it("switches saving what Cloud bots make, says where it goes, and opens that folder", async () => {
    bridge.setOutputs.mockResolvedValue({ ...base, outputs: { ...base.outputs, enabled: true } });
    await mount();
    expect(page()).toContain("Save what Cloud bots make to this computer");
    expect(page()).toContain("In Documents › MausBot, one folder for each bot.");
    expect(button("Open folder")).toBeUndefined();
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(bridge.setOutputs).toHaveBeenCalledWith(true);
    expect(document.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    await click("Open folder");
    expect(bridge.open).toHaveBeenCalledWith({ outputs: true });
    await act(async () => emit({ ...base, outputs: { ...base.outputs, enabled: true, problem: "Documents › MausBot is full." } }));
    expect(page()).toContain("Documents › MausBot is full.");
  });
});

describe("My Cloud's state", () => {
  it("follows main's pushes, and stops listening when closed", async () => {
    await mount();
    expect(bridge.onState).toHaveBeenCalledOnce();
    await act(async () => emit({ ...base, phase: "offline" }));
    expect(page()).toContain("The Cloud can't be reached right now. Files carry on when it's back.");
    act(() => root.unmount());
    expect(off).toHaveBeenCalledOnce();
  });

  it("asks to sign in again, through Settings → MausBot Cloud", async () => {
    await mount({ ...base, phase: "signed-out", shared: [folder("synced")] });
    expect(page()).toContain("Sign in to the Cloud again to keep sharing files.");
    expect(row("synced")).toBeTruthy();
    await click("Open MausBot Cloud settings");
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
  });

  it("without a Ready My Cloud, explains Files works with it and opens its settings", async () => {
    await mount({ ...base, phase: "unavailable" });
    expect(page()).toContain("Files works with MausBot Cloud.");
    expect(button("Add a folder")).toBeUndefined();
    await click("Open MausBot Cloud settings");
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
    delete window.ogb;
    await mount();
    expect(page()).toContain("Files works with MausBot Cloud.");
  });
});
