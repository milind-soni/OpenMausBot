import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: vi.fn() }));

import { setLocale } from "@/lib/i18n";
import type { EmailAccountView } from "../../shared/email";
import { EmailConnectForm } from "./EmailCard";
import { EmailCheckLines, EmailMailbox, EmailSignInNote, outgoingOf } from "./EmailMailbox";
import { EmailRequestSettled } from "./EmailRequestCard";

const WORKS: EmailAccountView = { address: "office@small-shop.at", imapHost: "imap.world4you.com", smtpHost: "smtp.world4you.com", smtpPort: 587, smtpSecurity: "starttls", connectedAt: "2026-11-06T00:00:00.000Z" };
const PROBLEM = "The outgoing server smtp.world4you.com:465 refused the password.";
const FAILS: EmailAccountView = { address: "office@small-shop.at", imapHost: "imap.world4you.com", sendingProblem: PROBLEM, smtpTried: { smtpHost: "smtp.world4you.com", smtpPort: 465, smtpSecurity: "tls" }, connectedAt: "2026-11-06T00:00:00.000Z" };
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const mailbox = (account: EmailAccountView, compact = false) => html(createElement(EmailMailbox, { account, onChanged: () => {}, compact }));

beforeEach(() => vi.stubGlobal("window", {}));
afterEach(() => { setLocale("en"); vi.unstubAllGlobals(); });

describe("the email card", () => {
  it("simple: an address, a password and Connect, with no server fields", () => {
    const form = html(createElement(EmailConnectForm, { initialAddress: "office@small-shop.at", submit: async () => null }));
    expect(form).toContain('type="email"');
    expect(form).toContain('value="office@small-shop.at"');
    expect(form).toContain('type="password"');
    expect(form).toContain(">Connect<");
    expect(form).not.toContain("data-email-outgoing-fields");
    expect(form).not.toContain("Incoming mail server");
    expect(form).not.toContain("data-email-checks");
  });

  it("ticking: Reading passes with the server it reached while Sending is still checked", () => {
    const form = html(createElement(EmailConnectForm, { submit: async () => null, reading: "imap.world4you.com" }));
    expect(form).toMatch(/data-email-check="done".*Reading.*imap\.world4you\.com/su);
    expect(form).toMatch(/data-email-check="waiting".*Sending/su);
    const lines = html(createElement(EmailCheckLines, { reading: { state: "done", host: "imap.x.example" }, sending: { state: "done", host: "smtp.x.example" } }));
    expect(lines.match(/data-email-check="done"/gu)).toHaveLength(2);
    expect(lines).toContain("smtp.x.example");
  });

  it("sending failed: the reason in one sentence and the Outgoing server open, filled with what was tried, and Try again", () => {
    const card = mailbox(FAILS);
    expect(card).toContain('data-email-check="failed"');
    expect(card).toContain(PROBLEM.replaceAll("'", "&#x27;"));
    expect(card).toContain("data-email-outgoing");
    expect(card).toContain('value="smtp.world4you.com"');
    expect(card).toContain('value="465"');
    expect(card).toMatch(/<option value="tls" selected="">SSL\/TLS<\/option>/u);
    expect(card).toContain('aria-label="Password for sending, if different"');
    expect(card).toContain(">Try again<");
    expect(card).not.toContain("Send a test to myself");
    expect(card).not.toContain("Connected.");
    expect(outgoingOf(FAILS)).toEqual({ smtpHost: "smtp.world4you.com", smtpPort: 465, smtpSecurity: "tls" });
  });

  it("connected: Connected., both lines ticked with their servers, and a test to myself", () => {
    const card = mailbox(WORKS);
    expect(card).toContain("Connected.");
    expect(card.match(/data-email-check="done"/gu)).toHaveLength(2);
    expect(card).toContain("smtp.world4you.com");
    expect(card).toContain(">Send a test to myself<");
    expect(card).not.toContain("data-email-outgoing-fields");
  });

  it("in Apps the same mailbox has its address, Test and Edit", () => {
    const row = mailbox(WORKS, true);
    expect(row).toContain("office@small-shop.at");
    expect(row).toContain(">Test<");
    expect(row).toContain(">Edit<");
    expect(row).not.toContain("Connected.");
    expect(mailbox(FAILS, true)).toContain(">Try again<");
  });

  it("Gmail and Outlook: one line and their own sign-in, or an app password", () => {
    const google = html(createElement(EmailSignInNote, { hint: { provider: "Google", app: "gmail", appPasswordUrl: "https://myaccount.google.com/apppasswords" } }));
    expect(google).toContain("Sign in with Google");
    expect(google).toContain('href="https://myaccount.google.com/apppasswords"');
    const microsoft = html(createElement(EmailSignInNote, { hint: { provider: "Microsoft", app: "outlook" } }));
    expect(microsoft).toContain("Sign in with Microsoft");
    expect(microsoft).not.toContain("href=");
    expect(html(createElement(EmailSignInNote, { hint: { provider: "Apple", appPasswordUrl: "https://account.apple.com/account/manage" } }))).toContain("Apple needs an app password");
  });

  it("in a chat, a connected card is that mailbox; without one it is the settled line", () => {
    expect(html(createElement(EmailRequestSettled, { address: WORKS.address, label: "Connect your mailbox", settled: "settled-line", initial: WORKS }))).toContain("Send a test to myself");
    expect(html(createElement(EmailRequestSettled, { address: WORKS.address, label: "Connect your mailbox", settled: "settled-line" }))).toBe("settled-line");
  });

  it("speaks the person's language", () => {
    setLocale("de");
    expect(mailbox(FAILS)).toContain("Postausgangsserver");
  });
});
