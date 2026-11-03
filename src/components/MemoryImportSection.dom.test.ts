// @vitest-environment happy-dom
// Settings → Import → Bring your memory: copy the prompt, paste an answer, see what was found, save it into About you and
// MausBot's note, and ask MausBot to set the old setup up.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body: unknown }>, dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    server.calls.push({ path, method: init?.method ?? "GET", body });
    return path === "/api/config" ? { profile: (body as { profile: unknown }).profile } : {};
  }),
  useStore: () => ({
    state: {
      config: { profile: { aboutMe: "I'm Sam." } },
      bots: [{ id: "scout", name: "Scout", threadId: "t-scout" }, { id: "maus", name: "MausBot", threadId: "t-maus", defaultBot: {} }],
    },
    dispatch: server.dispatch,
  }),
}));

const { MemoryImportSection } = await import("./MemoryImportSection");

const ANSWER = `## About me
- Goes by Sam; based in Pune (Asia/Kolkata)
- Prefers short answers

## My setup
### Inbox Triage
- **Purpose:** Sorts morning email.

## Ongoing context
Nothing yet.`;

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

beforeEach(() => {
  server.calls.length = 0;
  server.dispatch.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(MemoryImportSection)));
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

it("names the chosen assistant in the prompt and copies it", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  $<HTMLButtonElement>('[data-memory-source="Muse"]').click();
  await settle();
  expect($('[data-memory-prompt]').textContent).toContain("everything I've set up with you here in Muse");
  $<HTMLButtonElement>("[data-memory-copy]").click();
  await settle();
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("## My setup"));
  expect($("[data-memory-copy]").textContent).toBe("Copied");
});

it("says what it found, saves the facts and the note, and asks MausBot to set the old setup up", async () => {
  const field = $<HTMLTextAreaElement>("[data-memory-answer]");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, ANSWER);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect($("[data-memory-preview]").textContent).toContain("Facts about you: 2 · Things you set up: 1.");

  $<HTMLButtonElement>("[data-memory-save]").click();
  await settle();
  const aboutMe = (server.calls.find((call) => call.path === "/api/config")!.body as { profile: { aboutMe: string } }).profile.aboutMe;
  expect(aboutMe).toMatch(/^I'm Sam\.\n\nFrom Grok \(imported \d{4}-\d{2}-\d{2}\):\n- Goes by Sam; based in Pune \(Asia\/Kolkata\)\n- Prefers short answers$/);
  const note = server.calls.find((call) => call.path === "/api/bots/maus/memory/file")!;
  expect(note).toMatchObject({ method: "PUT", body: { path: "memory/imported-from-grok.md", text: expect.stringContaining("### Inbox Triage") } });
  expect(server.dispatch).toHaveBeenCalledWith({ type: "profileSaved", profile: { aboutMe } });
  expect($("[data-memory-import-done]").textContent).toContain("Facts added to About you: 2");

  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Ask MausBot to set these up here")!.click();
  await settle();
  expect(server.calls.at(-1)).toMatchObject({ path: "/api/bots/maus/messages", method: "POST", body: { threadId: "t-maus", text: expect.stringContaining("(Inbox Triage)") } });
  expect($("[data-memory-import-done]").textContent).toContain("Sent to MausBot.");
});

it("explains an answer it can't read instead of saving it", async () => {
  const field = $<HTMLTextAreaElement>("[data-memory-answer]");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Sorry, I can't help with that.");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("couldn't find");
  expect(document.querySelector("[data-memory-save]")).toBeNull();
});
