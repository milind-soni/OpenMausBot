// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

const posted = vi.hoisted(() => [] as Array<{ path: string; body: unknown }>);
/** What a press waits for before the server answers. */
const answered = vi.hoisted(() => ({ when: Promise.resolve(), fail: undefined as Error | undefined }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: async (path: string, init?: { body?: string }) => { posted.push({ path, body: JSON.parse(init?.body ?? "null") }); await answered.when; if (answered.fail) throw answered.fail; return { ok: true }; },
}));

const draft: Message = {
  id: "card-1", role: "bot", kind: "text", at: 1, text: "Draft saved in Gmail",
  emailDraft: { app: "gmail", draftId: "r-123", botId: "b1", to: ["ana@example.com"], cc: ["cy@example.com"], bcc: [], subject: "Launch", body: "Ready to go.", url: "https://mail.google.com/mail/#drafts?compose=m-1" },
};

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  posted.length = 0;
  answered.when = Promise.resolve();
  answered.fail = undefined;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

async function shown(message: Message = draft, viewOnly = false) {
  const { EmailDraftCard } = await import("./EmailDraftCard");
  await act(async () => { root.render(createElement(EmailDraftCard, { message, threadId: "t1", viewOnly })); });
}

const buttonNamed = (label: string) => [...document.querySelectorAll("button")].find((one) => one.textContent === label);
const click = async (label: string) => { await act(async () => { buttonNamed(label)!.click(); }); };

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the Gmail draft card", () => {
  it("shows the draft with Edit and Open in Gmail, and no Send", async () => {
    await shown();
    const text = container.textContent ?? "";
    for (const part of ["Gmail draft", "ana@example.com", "cy@example.com", "Launch", "Ready to go."]) expect(text).toContain(part);
    expect([...container.querySelectorAll("button")].map((one) => one.textContent)).toEqual(["Edit", "Open in Gmail"]);
    expect(posted).toEqual([]);
  });

  it("saves an edit with each address on its own", async () => {
    await shown();
    await click("Edit");
    const [to, , , subject] = [...container.querySelectorAll("input")];
    await act(async () => { type(to!, "ana@example.com, ben@example.com"); type(subject!, "Launch (final)"); });
    await click("Save");
    expect(posted).toEqual([{ path: "/api/email-draft", body: { threadId: "t1", messageId: "card-1", action: "save", base: {
      to: ["ana@example.com"], cc: ["cy@example.com"], bcc: [], subject: "Launch", body: "Ready to go.",
    }, draft: {
      to: ["ana@example.com", "ben@example.com"], cc: ["cy@example.com"], bcc: [], subject: "Launch (final)", body: "Ready to go.",
    } } }]);
  });

  it("offers no Edit once sent, or in a room's view-only copy", async () => {
    await shown({ ...draft, emailDraft: { ...draft.emailDraft!, sentAt: 5 } });
    expect(container.textContent).toContain("Sent from Gmail");
    expect(buttonNamed("Edit")).toBeUndefined();
    await shown(draft, true);
    expect(buttonNamed("Edit")).toBeUndefined();
    expect(buttonNamed("Open in Gmail")).toBeDefined();
  });

  it("shows an HTML body as its text, never its markup", async () => {
    await shown({ ...draft, emailDraft: { ...draft.emailDraft!, html: true, body: "<p>Hello <b>Ana</b></p><script>x()</script>" } });
    expect(container.textContent).toContain("Hello Ana");
    expect(container.innerHTML).not.toContain("<b>");
  });

  it("keeps an HTML body's lines and paragraphs", async () => {
    const { draftBodyText } = await import("./EmailDraftCard");
    expect(draftBodyText({ html: true, body: "<p>Hello</p>\n  <p>Ana<br>Ready?</p><ul><li>One</li><li>Two</li></ul>" })).toBe("Hello\n\nAna\nReady?\n\nOne\nTwo");
    expect(draftBodyText({ html: true, body: "<div>Hello<p>Ana</p></div>" })).toBe("Hello\n\nAna");
    expect(draftBodyText({ body: "Plain\n  text" })).toBe("Plain\n  text");
  });

  it("drops the editor when the draft is sent meanwhile", async () => {
    await shown();
    await click("Edit");
    expect(container.querySelectorAll("input")).toHaveLength(4);
    await shown({ ...draft, emailDraft: { ...draft.emailDraft!, sentAt: 5 } });
    expect(container.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(buttonNamed("Save")).toBeUndefined();
    expect(container.textContent).toContain("Sent from Gmail");
  });

  it("locks the fields while Save runs, so nothing typed then is lost", async () => {
    let answer!: () => void;
    answered.when = new Promise((resolve) => { answer = resolve; });
    await shown();
    await click("Edit");
    await click("Save");
    const fields = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")];
    expect(fields).toHaveLength(5);
    expect(fields.every((field) => field.disabled)).toBe(true);
    await act(async () => { answer(); });
    expect(container.querySelectorAll("input, textarea")).toHaveLength(0);
  });

  it("closes the editor when the draft changed in Gmail, so the next edit starts from what Gmail holds", async () => {
    const { ApiError } = await import("@/state/store");
    const changed = "This draft changed in Gmail since you started editing, so nothing was saved. The card now shows the latest version: edit it again.";
    answered.fail = new ApiError(changed, 409, { error: changed, errorKey: "serverError.emailDraft.changed" });
    await shown();
    await click("Edit");
    await click("Save");
    expect(container.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(container.querySelector("[role=alert]")?.textContent).toBe(changed);
    // Any other refusal keeps what was typed.
    answered.fail = new ApiError("Gmail refused: busy", 502, { error: "Gmail refused: busy" });
    await click("Edit");
    await click("Save");
    expect(container.querySelectorAll("input")).toHaveLength(4);
  });
});
