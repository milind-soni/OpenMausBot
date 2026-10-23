// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", () => ({ api: request }));
import { TeamMemoryDialog } from "./TeamMemoryDialog";

let root: Root;
let host: HTMLDivElement;
const entry = { id: "note", kind: "decision", name: "Colour", detail: "Green", aliases: [], status: "accepted", revision: "revision-one",
  source: { botId: "b", botName: "Editor", threadId: "t", at: 1 }, updatedAt: 1 };
beforeEach(() => {
  request.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });
async function render() {
  flushSync(() => root.render(createElement(TeamMemoryDialog, { section: "Editing", label: "Editing", onClose: () => undefined })));
  await vi.waitFor(() => expect(document.querySelector('[aria-label="Colour detail"]')).not.toBeNull());
}

it("keeps the user's unsaved text after a conflict and reloads the latest version", async () => {
  let reads = 0;
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") throw new Error("This department memory changed. Reload it before saving or approving.");
    reads++;
    return { entries: [{ ...entry, ...(reads > 1 ? { detail: "Amber", revision: "revision-two" } : {}) }], loadedIds: [entry.id] };
  });
  await render();
  const field = document.querySelector<HTMLInputElement>('[aria-label="Colour detail"]')!;
  field.value = "My unsaved orange treatment";
  flushSync(() => field.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Your unsaved draft: My unsaved orange treatment"));
  const sent = request.mock.calls.find(([, init]) => init?.method === "PATCH")!;
  expect(JSON.parse(sent[1].body)).toEqual({ detail: "My unsaved orange treatment", expectedRevision: "revision-one" });
  const reload = [...document.querySelectorAll("button")].find(button => button.textContent === "Reload latest")!;
  flushSync(() => reload.click());
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[aria-label="Colour detail"]')!.value).toBe("Amber"));
  expect(document.body.textContent).toContain("Your unsaved draft: My unsaved orange treatment");
});

it("shows omitted notes as searchable and sends a revision when pinning", async () => {
  request.mockResolvedValue({ entries: [entry], loadedIds: [] });
  await render();
  expect(document.body.textContent).toContain("0 of 1 accepted notes load automatically");
  expect(document.body.textContent).toContain("Searchable");
  flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="Pin Colour"]')!.click());
  await vi.waitFor(() => expect(request.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
  expect(JSON.parse(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body)).toEqual({ pinned: true, expectedRevision: "revision-one" });
});

it("re-enables controls after refreshing a response without capacity data", async () => {
  let pinned = false;
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { pinned = true; return { entries: [{ ...entry, pinned }] }; }
    return { entries: [{ ...entry, pinned }], loadedIds: [entry.id] };
  });
  await render();
  flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="Pin Colour"]')!.click());
  await vi.waitFor(() => expect(request.mock.calls.length).toBe(3));
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[aria-label="Remove Colour"]')!.disabled).toBe(false));
});


it("retains one entry's failed draft when another entry saves successfully", async () => {
  const other = { ...entry, id: "other", name: "Audio" };
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PATCH" && path.includes("/note?")) throw new Error("conflict");
    return { entries: [entry, other], loadedIds: [entry.id, other.id] };
  });
  await render();
  const field = document.querySelector<HTMLInputElement>('[aria-label="Colour detail"]')!;
  field.value = "Keep my orange draft";
  flushSync(() => field.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Keep my orange draft"));
  const audio = document.querySelector<HTMLInputElement>('[aria-label="Audio detail"]')!;
  audio.value = "Quiet soundtrack";
  flushSync(() => audio.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await vi.waitFor(() => expect(request.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2));
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[aria-label="Remove Audio"]')!.disabled).toBe(false));
  expect(document.body.textContent).toContain("Keep my orange draft");
});


it("restores a historical name even when its detail is unchanged", async () => {
  request.mockResolvedValue({ entries: [{ ...entry, history: [{ name: "Earlier colour", detail: entry.detail, at: 1 }] }], loadedIds: [entry.id] });
  await render();
  flushSync(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Restore text")!.click());
  await vi.waitFor(() => expect(request.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
  expect(JSON.parse(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body))
    .toEqual({ name: "Earlier colour", detail: entry.detail, expectedRevision: entry.revision });
});
