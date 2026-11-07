// @vitest-environment happy-dom
// Removing a chip: a finished upload is dropped only after a confirm; one still uploading is a plain cancel.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";

const fixture = vi.hoisted(() => ({
  advanced: true,
  agentsMcp: true,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  groupCall: null as Record<string, unknown> | null,
  liveCall: null as unknown,
  config: undefined as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config ?? original.initialState.config, bots: [bot], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: () => null }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const UPLOAD_PATH = "/home/a/.openmausbot/attachments/0f1e2d3c-aaaa-4bbb-8ccc-123456789abc.txt";
const finished = { kind: "file" as const, id: "file-1", path: UPLOAD_PATH, name: "notes.txt", size: 3 };
const uploading = { kind: "image" as const, id: "img-1", path: "", name: "snap.png", size: 0, mime: "image/png", uploading: true };

let root: Root;
let container: HTMLDivElement;
const render = (props: Parameters<typeof Composer>[0]) => flushSync(() => root.render(createElement(Composer, props)));
const remove = () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove file"]');
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};

beforeEach(() => {
  fixture.advanced = true;
  fixture.liveCall = null;
  fixture.config = undefined;
  setCallMode("turns");
  fixture.call = null;
  fixture.groupCall = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("removing a composer attachment", () => {
  it("deletes a finished upload only once the person confirms", () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmMock);
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [finished] });
    render({ bot });
    click(remove());
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/attachments/"))).toEqual([
      [UPLOAD_PATH.replace(/^.*\/attachments\//, "/api/attachments/"), { method: "DELETE" }],
    ]);
    expect(remove()).toBeNull();
  });

  it("keeps the attachment when the confirm is declined", () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [finished] });
    render({ bot });
    click(remove());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(remove()).not.toBeNull();
  });

  it("cancels an upload still in flight without asking", () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmMock);
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [uploading] });
    render({ bot });
    click(container.querySelector<HTMLButtonElement>('button[aria-label="Remove file"]'));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Remove file"]')).toBeNull();
  });
});
