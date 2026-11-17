// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamFilesListing } from "../../../shared/team-files";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ state: { config: { team: { id: "team-acme", name: "Acme" } } }, dispatch: vi.fn(), api: vi.fn() }));
class FakeApiError extends Error {
  status: number; body?: Record<string, unknown>;
  constructor(message: string, status: number, body?: Record<string, unknown>) { super(message); this.status = status; this.body = body; }
}
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/state/api", () => ({ api: fixture.api, ApiError: FakeApiError }));

const { TeamFilesPage, changedLine, formatSize, refusalText } = await import("./TeamFilesPage");

const NOW = Date.parse("2026-11-17T12:00:00Z");
const GB = 1024 ** 3;
const listings: Record<string, TeamFilesListing> = {
  "": {
    path: "", used: 1.5 * GB, cap: 5 * GB, uploadMax: 100 * 1024 ** 2, admin: false, entries: [
      { name: "payroll", path: "payroll", kind: "folder", size: 0, modifiedAt: NOW, canDelete: false, mine: false, last: { at: NOW - 2 * 3_600_000, action: "added", person: "Mira", bot: "Payroll" } },
      { name: "handbook.md", path: "handbook.md", kind: "file", size: 2048, modifiedAt: NOW, canDelete: true, mine: true, last: { at: NOW - 60_000 * 5, action: "uploaded", person: "Ben" } },
      { name: "logo.png", path: "logo.png", kind: "file", size: 10, modifiedAt: NOW, canDelete: false, mine: false },
    ],
  },
  payroll: {
    path: "payroll", used: 1.5 * GB, cap: 5 * GB, uploadMax: 100 * 1024 ** 2, admin: false, entries: [
      { name: "nov.csv", path: "payroll/nov.csv", kind: "file", size: 20, modifiedAt: NOW, canDelete: false, mine: false, last: { at: NOW - 2 * 3_600_000, action: "added", person: "Mira", bot: "Payroll" } },
    ],
  },
};

let root: Root, host: HTMLElement;
const calls: Array<{ path: string; method: string; body?: string }> = [];
const fetches: Array<{ url: string; method: string }> = [];
let putAnswer: () => Response;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  calls.length = 0;
  fetches.length = 0;
  putAnswer = () => new Response("{}", { status: 201 });
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
    const listed = /^\/api\/team-files\?path=(.*)$/.exec(path);
    if (listed) return listings[decodeURIComponent(listed[1]!)];
    return { ok: true };
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    fetches.push({ url, method: init?.method ?? "GET" });
    return init?.method === "PUT" ? putAnswer() : new Response("name,net\nMira,4200\n", { status: 200 });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const render = async () => { await act(async () => root.render(createElement(TeamFilesPage))); await act(async () => {}); };
const button = (label: string) => [...host.querySelectorAll("button")].find((one) => one.getAttribute("aria-label") === label || one.textContent === label)!;

describe("the Team files page", () => {
  it("lists the folder with who changed each file, the space used, and actions by what the viewer may do", async () => {
    await render();
    expect(host.querySelector("[data-team-files]")?.getAttribute("data-team-files")).toBe("3");
    expect(host.textContent).toContain("1.5 GB of 5 GB used");
    const rows = [...host.querySelectorAll("[data-team-file]")];
    expect(rows.map((row) => row.getAttribute("data-team-file"))).toEqual(["payroll", "handbook.md", "logo.png"]);
    expect(rows[0]!.textContent).toContain("Changed by Mira with Payroll · 2 hr ago");
    expect(rows[1]!.textContent).toContain("2 KB · Uploaded by Ben · 5 min ago");
    expect(rows[1]!.querySelector("[aria-label='Delete']")).not.toBeNull();
    expect(rows[2]!.querySelector("[aria-label='Delete']"), "not theirs").toBeNull();
    expect(rows[1]!.querySelector("a[download]")?.getAttribute("href")).toBe("/api/team-files/file?path=handbook.md&download=1");
  });

  it("opens a folder with breadcrumbs back, and previews text", async () => {
    await render();
    await act(async () => button("Open payroll").click());
    await act(async () => {});
    expect(calls.at(-1)?.path).toBe("/api/team-files?path=payroll");
    expect(host.querySelector("nav [aria-current='page']")?.textContent).toBe("payroll");
    await act(async () => button("Open nov.csv").click());
    expect(host.querySelector("[data-team-file-preview]")?.textContent).toBe("name,net\nMira,4200\n");
    await act(async () => [...host.querySelectorAll("nav button")][0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => {});
    expect(calls.at(-1)?.path).toBe("/api/team-files?path=");
  });

  it("uploads what is dropped into the open folder, and says why one was refused", async () => {
    await render();
    const file = new File(["hello"], "notes.txt");
    const drop = new Event("drop", { bubbles: true }) as Event & { dataTransfer: { files: File[] } };
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
    await act(async () => host.querySelector("[data-team-files]")!.dispatchEvent(drop));
    await act(async () => {});
    expect(fetches.find((one) => one.method === "PUT")?.url).toBe("/api/team-files/file?path=&name=notes.txt");
    putAnswer = () => new Response(JSON.stringify({ error: "full", code: "full" }), { status: 507 });
    const picker = host.querySelector<HTMLInputElement>("[data-testid='team-files-picker']")!;
    Object.defineProperty(picker, "files", { value: [new File(["x"], "big.bin")], configurable: true });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => {});
    expect(host.querySelector("[role='alert']")?.textContent).toBe("Team files are full (5 GB). Remove files to make room.");
  });

  it("makes a folder and deletes after asking", async () => {
    await render();
    await act(async () => button("New folder").click());
    const input = host.querySelector<HTMLInputElement>("form input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Clients");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(calls.find((call) => call.path === "/api/team-files/folder")).toEqual({ path: "/api/team-files/folder", method: "POST", body: JSON.stringify({ path: "Clients" }) });
    vi.stubGlobal("confirm", () => true);
    await act(async () => host.querySelector<HTMLElement>("[data-team-file='handbook.md'] [aria-label='Delete']")!.click());
    expect(calls.find((call) => call.path === "/api/team-files/delete")?.body).toBe(JSON.stringify({ path: "handbook.md" }));
  });
});

describe("its words", () => {
  it("names who changed a file, and what a refusal means", () => {
    expect(changedLine({ last: { at: NOW - 3_600_000, action: "changed", bot: "Payroll" } }, NOW)).toBe("Changed by Payroll · 1 hr ago");
    expect(changedLine({ last: { at: NOW, action: "folder", person: "Ada" } }, NOW)).toBe("Made by Ada · just now");
    expect(changedLine({}, NOW)).toBeNull();
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(100 * 1024 ** 2)).toBe("100 MB");
    const limits = { uploadMax: 100 * 1024 ** 2, cap: 5 * GB };
    expect(refusalText(new FakeApiError("x", 413, { code: "too_large" }), limits)).toBe("A file may be at most 100 MB.");
    expect(refusalText(new FakeApiError("x", 403, { code: "forbidden" }), limits)).toBe("Only an admin, or whoever uploaded it, can do that.");
    expect(refusalText(new Error("offline"), limits)).toBe("That didn't work. Try again.");
  });
});
