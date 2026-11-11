// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportInput, SupportResult } from "../../electron/support-request.mjs";
import { supportOffer, supportProblems } from "@/lib/contact-support";
import { setLocale } from "@/lib/i18n";
import { ContactSupportDialog, useContactSupport } from "./ContactSupportDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const OFFER: { email: string; form: boolean; account: string | null } = { email: "help@example.test", form: true, account: "payer@example.test" };
let root: Root, host: HTMLDivElement;
let send: ReturnType<typeof vi.fn<(input: SupportInput) => Promise<SupportResult>>>;
let diagnostics: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
const onClose = vi.fn();

beforeEach(() => {
  setLocale("en");
  send = vi.fn(async () => ({ outcome: "sent", id: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }) as SupportResult);
  diagnostics = vi.fn(async () => "MausBot support request diagnostics");
  onClose.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; });

const open = async (offer = OFFER) => { await act(async () => { root.render(createElement(ContactSupportDialog, { offer, send, diagnostics, onClose })); }); };
const sheet = () => document.querySelector<HTMLElement>("[data-contact-support]")!;
const field = (label: string) => [...sheet().querySelectorAll("label")].find((item) => item.textContent?.startsWith(label))!.querySelector("select, textarea, input") as HTMLInputElement;
const button = (label: string) => [...sheet().querySelectorAll("button")].find((item) => item.textContent === label)!;
const enter = async (label: string, value: string) => {
  const target: HTMLElement = field(label);
  const prototype = target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, value); target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
};
const click = async (target: HTMLElement) => { await act(async () => { target.click(); await Promise.resolve(); }); };
const fill = async (topic = "billing") => { await enter("Topic", topic); await enter("Message", "I was charged twice."); };

describe("the dialog", () => {
  it("opens on its form: the topics, the signed-in address to reply to, diagnostics off, Send and Cancel", async () => {
    await open();
    expect(sheet().getAttribute("role")).toBe("dialog");
    expect(sheet().getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(sheet().getAttribute("aria-labelledby")!)?.textContent).toBe("Contact support");
    expect(sheet().textContent).toContain("Write to the MausBot team. We reply by email, usually within one working day.");
    expect([...field("Topic").querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Choose one", "Billing or refund", "Something isn't working", "A question", "Something else"]);
    expect(document.activeElement).toBe(field("Topic"));
    expect(field("Reply to").value).toBe("payer@example.test");
    expect(field("Include diagnostics").checked).toBe(false);
    expect(sheet().textContent).toContain("Adds the app's version, your system and its recent warnings and errors. Never your chats or files.");
    expect([...sheet().querySelectorAll("form button")].map((item) => item.textContent)).toEqual(["Cancel", "Send"]);
    await click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks for each required field in words a screen reader reads with it, and sends nothing until they are there", async () => {
    await open({ ...OFFER, account: null });
    await click(button("Send"));
    const problems = [...sheet().querySelectorAll('[aria-invalid="true"]')].map((item) => document.getElementById(item.getAttribute("aria-describedby")!)?.textContent);
    expect(problems).toEqual(["Choose what your message is about.", "Write your message.", "Enter the email address we should reply to."]);
    expect(document.activeElement).toBe(field("Topic"));
    await fill();
    await enter("Reply to", "me@example.test\nBcc: someone@example.test");
    await click(button("Send"));
    expect(document.activeElement).toBe(field("Reply to"));
    expect(send).not.toHaveBeenCalled();
  });

  it("starts diagnostics on for something that isn't working and off for billing, and reads them only once included", async () => {
    await open();
    await enter("Topic", "broken");
    expect(field("Include diagnostics").checked).toBe(true);
    expect(diagnostics).toHaveBeenCalledOnce();
    await enter("Topic", "billing");
    expect(field("Include diagnostics").checked).toBe(false);
    await enter("Topic", "question");
    expect(field("Include diagnostics").checked).toBe(false);
  });

  it("sends the form and shows the report number and when we reply", async () => {
    await open();
    await fill("broken");
    await enter("Reply to", "  Me@Example.test ");
    await click(button("Send"));
    expect(send).toHaveBeenCalledWith({ topic: "broken", message: "I was charged twice.", replyTo: "Me@Example.test", diagnostics: "MausBot support request diagnostics" });
    expect(sheet().getAttribute("data-contact-support")).toBe("sent");
    expect(sheet().querySelector('[role="status"]')?.textContent).toBe("Sent. Your report number is 6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.");
    expect(sheet().textContent).toContain("We reply by email, usually within one working day.");
    await click(button("Done"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends no diagnostics unless they are included", async () => {
    await open();
    await fill("billing");
    await click(button("Send"));
    expect(send).toHaveBeenCalledWith({ topic: "billing", message: "I was charged twice.", replyTo: "payer@example.test" });
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("says a message that can't go now is saved and goes by itself, with the address to write to", async () => {
    send.mockResolvedValueOnce({ outcome: "queued" });
    await open();
    await fill();
    await click(button("Send"));
    expect(sheet().querySelector('[role="status"]')?.textContent).toBe("Saved. It can't be sent right now, so it will go by itself as soon as MausBot can reach the team.");
    expect(sheet().querySelector("[data-support-email]")?.textContent).toBe("Support by email: help@example.testCopy address");
  });

  it("shows the address to write to while it is switched off: at once, or when the Admin says so on Send", async () => {
    await open({ ...OFFER, form: false });
    expect(sheet().getAttribute("data-contact-support")).toBe("off");
    expect(sheet().querySelector("textarea")).toBeNull();
    expect(sheet().querySelector('[role="status"]')?.textContent).toBe("Support by email: help@example.testCopy address");
    await act(async () => root.unmount()); root = createRoot(host);
    send.mockResolvedValueOnce({ outcome: "off", email: "help@example.test" });
    await open();
    await fill();
    await click(button("Send"));
    expect(sheet().querySelector('[role="status"]')?.textContent).toBe("Support by email: help@example.testCopy address");
  });

  it("keeps the form open with a plain line when it didn't go: refused, signed out, too many waiting, or an error", async () => {
    const said: [SupportResult | Error, string][] = [
      [{ outcome: "refused", detail: "Write your message in 1 to 5,000 characters." }, "It couldn't be sent: Write your message in 1 to 5,000 characters."],
      [{ outcome: "signin" }, "Sign in to MausBot Cloud again to contact support."],
      [{ outcome: "full" }, "A few messages are already waiting to be sent. Try again once they have gone."],
      [new Error("ipc"), "It couldn't be sent. Try again."],
    ];
    await open();
    await fill();
    for (const [answer, line] of said) {
      if (answer instanceof Error) send.mockRejectedValueOnce(answer); else send.mockResolvedValueOnce(answer);
      await click(button("Send"));
      expect(sheet().querySelector('[role="alert"]')?.textContent).toBe(line);
      expect(field("Message").value).toBe("I was charged twice.");
    }
  });

  it("says when the account may not contact support, and closes on Escape", async () => {
    send.mockResolvedValueOnce({ outcome: "unavailable" });
    await open();
    await fill();
    await click(button("Send"));
    expect(sheet().querySelector('[role="status"]')?.textContent).toBe("Contact support isn't available for this account.");
    await act(async () => { sheet().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("the Help menu's entry on this computer's page", () => {
  /** This app's own page, signed in to MausBot Cloud with `plan` (null: signed out of it). */
  const offeredWith = async (plan: Record<string, unknown> | null) => {
    const shown: Array<(() => void) | undefined> = [];
    (window as unknown as { ogb: unknown }).ogb = { remoteClient: {}, cloudAccount: plan ? { onState: () => () => {} } : undefined,
      cloudPlan: { state: async () => plan, support: send } };
    const Probe = () => { shown.push(useContactSupport(false).open); return null; };
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { await Promise.resolve(); });
    return shown.at(-1);
  };
  afterEach(() => { delete (window as unknown as { ogb?: unknown }).ogb; });
  it("is there for a paid plan, its own or its team's, and not for a free or signed-out account", async () => {
    expect(await offeredWith({ status: "paid", tier: "pro", support: OFFER })).toBeTypeOf("function");
    expect(await offeredWith({ status: "none", support: OFFER })).toBeTypeOf("function");
    expect(await offeredWith({ status: "none" })).toBeUndefined();
    expect(await offeredWith({ status: "signin", tier: "pro" })).toBeUndefined();
    expect(await offeredWith(null)).toBeUndefined();
  });
});

describe("who is offered it", () => {
  const bridge = { support: async () => ({ outcome: "sent", id: "x" }) as SupportResult };
  it("only an account the Admin says may write: never a free or signed-out one, nor an app without the bridge", () => {
    expect(supportOffer({ status: "paid", tier: "pro", support: OFFER }, bridge)).toEqual(OFFER);
    expect(supportOffer({ status: "none", support: OFFER }, bridge), "a member of a paid team").toEqual(OFFER);
    expect(supportOffer({ status: "none" }, bridge), "a free account").toBeNull();
    expect(supportOffer({ status: "signin", tier: "pro" }, bridge), "signed out").toBeNull();
    expect(supportOffer(null, undefined), "no MausBot Cloud sign-in on this app at all").toBeNull();
    expect(supportOffer({ status: "paid", support: OFFER }, {}), "an older main").toBeNull();
  });
  it("checks the form's fields as the Admin will", () => {
    expect(supportProblems({ topic: "", message: " ", replyTo: "a@b" })).toEqual({ topic: true, message: true, replyTo: true });
    expect(supportProblems({ topic: "other", message: "x".repeat(5_001), replyTo: "a@b.example" })).toEqual({ topic: false, message: true, replyTo: false });
    expect(supportProblems({ topic: "other", message: "Hi", replyTo: " A@B.example " })).toEqual({ topic: false, message: false, replyTo: false });
  });
});
