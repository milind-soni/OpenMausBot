// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

const posted = vi.hoisted(() => [] as Array<{ path: string; body: unknown }>);
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: async (path: string, init?: { body?: string }) => { posted.push({ path, body: JSON.parse(init?.body ?? "null") }); return { ok: true }; },
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
  it("shows the draft and sends it only after the person confirms", async () => {
    await shown();
    const text = container.textContent ?? "";
    for (const part of ["Gmail draft", "ana@example.com", "cy@example.com", "Launch", "Ready to go."]) expect(text).toContain(part);
    await click("Send");
    expect(posted).toEqual([]);
    expect(document.body.textContent).toContain("It goes to ana@example.com, cy@example.com now, from your Gmail.");
    const confirm = [...document.querySelectorAll("button")].filter((one) => one.textContent === "Send").at(-1)!;
    await act(async () => { confirm.click(); });
    expect(posted).toEqual([{ path: "/api/email-draft", body: { threadId: "t1", messageId: "card-1", action: "send" } }]);
  });

  it("saves an edit with each address on its own", async () => {
    await shown();
    await click("Edit");
    const [to, , , subject] = [...container.querySelectorAll("input")];
    await act(async () => { type(to!, "ana@example.com, ben@example.com"); type(subject!, "Launch (final)"); });
    await click("Save");
    expect(posted).toEqual([{ path: "/api/email-draft", body: { threadId: "t1", messageId: "card-1", action: "save", draft: {
      to: ["ana@example.com", "ben@example.com"], cc: ["cy@example.com"], bcc: [], subject: "Launch (final)", body: "Ready to go.",
    } } }]);
  });

  it("offers no Edit or Send once sent, or in a room's view-only copy", async () => {
    await shown({ ...draft, emailDraft: { ...draft.emailDraft!, sentAt: 5 } });
    expect(container.textContent).toContain("Sent from Gmail");
    expect(buttonNamed("Send")).toBeUndefined();
    expect(buttonNamed("Edit")).toBeUndefined();
    await shown(draft, true);
    expect(buttonNamed("Send")).toBeUndefined();
    expect(buttonNamed("Open in Gmail")).toBeDefined();
  });

  it("shows an HTML body as its text, never its markup", async () => {
    await shown({ ...draft, emailDraft: { ...draft.emailDraft!, html: true, body: "<p>Hello <b>Ana</b></p><script>x()</script>" } });
    expect(container.textContent).toContain("Hello Ana");
    expect(container.innerHTML).not.toContain("<b>");
  });
});
