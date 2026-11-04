// @vitest-environment happy-dom
// Settings → Import → Bring your memory: copy the prompt, paste an answer, see what was found, save it into About you and
// MausBot's note, and ask MausBot to set the old setup up.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>, dispatch: vi.fn(),
  aboutMe: "I'm Sam.", noteFails: false, hold: null as Promise<void> | null,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const method = init?.method ?? "GET";
    server.calls.push({ path, method, body });
    if (path === "/api/config" && method === "GET") return { profile: { aboutMe: server.aboutMe } };
    if (path === "/api/config") return { profile: (body as { profile: unknown }).profile };
    if (path.endsWith("/memory/file") && server.noteFails) throw new Error("memory files are capped at 256KB");
    if (path.endsWith("/messages") && server.hold) await server.hold;
    return {};
  }),
  useStore: () => ({
    state: {
      // Behind the server: a bot learned a fact the page hasn't heard about.
      config: { profile: { aboutMe: "I'm Sam (stale)." } },
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
  server.aboutMe = "I'm Sam.\n- Learned: likes tea";
  server.noteFails = false;
  server.hold = null;
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
  const configCalls = server.calls.filter((call) => call.path === "/api/config");
  expect(configCalls.map((call) => call.method)).toEqual(["GET", "PUT"]);
  const aboutMe = (configCalls[1]!.body as { profile: { aboutMe: string } }).profile.aboutMe;
  // Merged into About you as stored, so the fact a bot learned is kept.
  expect(aboutMe).toMatch(/^I'm Sam\.\n- Learned: likes tea\n\nFrom Grok \(imported \d{4}-\d{2}-\d{2}\):\n- Goes by Sam; based in Pune \(Asia\/Kolkata\)\n- Prefers short answers$/);
  const note = server.calls.find((call) => call.path === "/api/bots/maus/memory/file")!;
  expect(note).toMatchObject({ method: "PUT", body: { path: "memory/imported-from-grok.md", text: expect.stringContaining("### Inbox Triage") } });
  expect(server.dispatch).toHaveBeenCalledWith({ type: "profileSaved", profile: { aboutMe } });
  expect($("[data-memory-import-done]").textContent).toContain("Facts added to About you: 2");

  let release!: () => void;
  server.hold = new Promise((resolve) => { release = resolve; });
  const askButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Ask MausBot to set these up here")!;
  askButton.click();
  await settle();
  askButton.click();
  await settle();
  expect(server.calls.filter((call) => call.path.endsWith("/messages"))).toHaveLength(1);
  release();
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

const paste = async (text: string) => {
  const field = $<HTMLTextAreaElement>("[data-memory-answer]");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};

it("says the copy failed next to Copy prompt, before anything is pasted", async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("denied"); }) }, configurable: true });
  $<HTMLButtonElement>("[data-memory-copy]").click();
  await settle();
  expect($("[data-memory-copy-error]").textContent).toBe("Couldn't copy. Open the prompt below and copy it by hand.");
});

it("points a Grok Bot move to its own dialog only when Grok is chosen", async () => {
  expect(document.querySelector("[data-memory-grok-bot]")?.textContent).toContain("Move from Grok Bot");
  $<HTMLButtonElement>('[data-memory-source="Muse"]').click();
  await settle();
  expect(document.querySelector("[data-memory-grok-bot]")).toBeNull();
});

it("keeps the facts it saved when the note can't be written, and tries the note again", async () => {
  server.noteFails = true;
  await paste(ANSWER);
  $<HTMLButtonElement>("[data-memory-save]").click();
  await settle();
  expect($("[data-memory-import-done]").textContent).toContain("Facts added to About you: 2");
  expect($("[data-memory-note-error]").textContent).toContain("The facts are saved, but the note couldn't be: memory files are capped at 256KB");
  server.noteFails = false;
  [...document.querySelectorAll<HTMLButtonElement>("[data-memory-note-error] button")][0]!.click();
  await settle();
  expect(document.querySelector("[data-memory-note-error]")).toBeNull();
  expect($("[data-memory-import-done]").textContent).toContain("MausBot has the whole answer in its notes.");
});

it("never says the facts left out are in a note when no note is kept", async () => {
  const many = Array.from({ length: 120 }, (_, index) => `- Fact ${index} about Sam, written out at some length to fill About you`).join("\n");
  await paste(`## About me\n${many}`);
  const keep = [...document.querySelectorAll<HTMLInputElement>('[data-memory-preview] input[type="checkbox"]')][1]!;
  keep.click();
  await settle();
  $<HTMLButtonElement>("[data-memory-save]").click();
  await settle();
  const done = $("[data-memory-import-done]").textContent!;
  expect(done).toMatch(/Not added to About you, to keep it short: \d+\./);
  expect(done).not.toContain("in the note");
});

