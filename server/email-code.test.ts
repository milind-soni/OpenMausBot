import { describe, expect, it, vi } from "vitest";

import { extractCode, senderDomain, sentBySite, waitForEmailCode, type CodeMailbox, type MailSummary } from "./email-code.ts";

const ASKED = 1_700_000_000_000;

function clocked() {
  let clock = ASKED;
  return { now: () => clock, sleep: async (ms: number) => { clock += ms; }, advance: (ms: number) => { clock += ms; } };
}

function mailbox(messages: Array<MailSummary & { text?: string | null }>): CodeMailbox & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    list: async () => messages,
    body: async (id) => { read.push(id); return messages.find((mail) => mail.id === id)?.text ?? null; },
  };
}

const mail = (over: Partial<MailSummary & { text: string | null }> = {}) => ({ id: "m1", at: ASKED + 2_000, from: "Acme <no-reply@mail.acme.test>", subject: "Your sign-in code", text: "Your verification code is 483920. It expires in 10 minutes.", ...over });

describe("extractCode", () => {
  it.each([
    ["Your code", "Your verification code is 483920.", "483920"],
    ["483920 is your code", "", "483920"],
    ["Sign in", "<html><head><style>.a{}</style></head><body><p>Your one-time code:</p><div>48 39</div><h1>728194</h1></body></html>", "728194"],
    ["Code", "Enter this code: 123-456", "123456"],
    ["Verify", "Your security code: A1B2C3", "A1B2C3"],
    ["Código", "Seu código de verificação é 553211", "553211"],
    ["Code", "Your code is 900100. Again: 900100.", "900100"],
  ])("takes the one code named as one in %s", (subject, body, code) => {
    expect(extractCode(subject, body)).toEqual({ kind: "code", code });
  });

  it.each([
    ["no number", "Your sign-in code", "Click the button to continue."],
    ["a number nothing calls a code", "Order shipped", "Order 483920 is on its way."],
    ["a zip code", "Hello", "Delivered to zip code 94103."],
    ["a code inside a link", "Welcome", "Your code: https://acme.test/v?c=482913 was generated."],
    ["a year in the footer", "Your code", "Use the app. © 2026 Acme. Your code is below."],
  ])("finds none in %s", (_name, subject, body) => {
    expect(extractCode(subject, body).kind).toBe("none");
  });

  it("calls two different codes ambiguous rather than guessing", () => {
    expect(extractCode("Code", "Your code is 111222 or use code 333444")).toEqual({ kind: "ambiguous" });
  });

  it("keeps only codes that fit the boxes on the page", () => {
    expect(extractCode("Code", "Your code is 483920 (reference 1234567)", 6)).toEqual({ kind: "code", code: "483920" });
    expect(extractCode("Code", "Your code is 483920", 4)).toEqual({ kind: "none" });
  });
});

describe("senderDomain", () => {
  it.each([
    ["no-reply@acme.test", "acme.test"],
    ["Acme <no-reply@mail.acme.test>", "mail.acme.test"],
    ['"Acme, Inc" <no-reply@acme.test>', "acme.test"],
  ])("reads %s", (from, domain) => expect(senderDomain(from)).toBe(domain));

  it.each([
    "evil <no-reply@acme.test> <x@evil.test>",
    "no-reply@acme.test <x@evil.test>",
    "x@evil.test, no-reply@acme.test",
    "Acme <no-reply@acme.test> trailing",
    "not an address",
    "hello no-reply@acme.test",
  ])("reads no sender from %s", (from) => expect(senderDomain(from)).toBeNull());

  it("matches by registrable domain and never by a look-alike", () => {
    expect(sentBySite("a@mail.acme.test", "acme.test")).toBe(true);
    expect(sentBySite("a@acme.test.evil.test", "acme.test")).toBe(false);
    expect(sentBySite("a@evil-acme.test", "acme.test")).toBe(false);
  });
});

describe("waitForEmailCode", () => {
  const options = (time: ReturnType<typeof clocked>) => ({ site: "acme.test", askedAt: ASKED, isUsed: () => false, now: time.now, sleep: time.sleep });

  it("takes a matching new code", async () => {
    expect(await waitForEmailCode([mailbox([mail()])], options(clocked()))).toEqual({ kind: "code", code: "483920" });
  });

  it("reads no body of a message from another sender", async () => {
    const box = mailbox([mail({ from: "x@evil.test", subject: "Lunch?" })]);
    await waitForEmailCode([box], options(clocked()));
    expect(box.read).toEqual([]);
  });

  it("reports the wrong sender and types nothing from it", async () => {
    expect(await waitForEmailCode([mailbox([mail({ from: "no-reply@evil.test" })])], options(clocked()))).toEqual({ kind: "miss", why: "wrong-sender" });
  });

  it("ignores a message from before the code was asked for, past the clock skew", async () => {
    expect(await waitForEmailCode([mailbox([mail({ at: ASKED - 31_000 })])], options(clocked()))).toEqual({ kind: "miss", why: "not-found" });
    expect(await waitForEmailCode([mailbox([mail({ at: ASKED - 29_000 })])], options(clocked()))).toEqual({ kind: "code", code: "483920" });
  });

  it("falls back on two different codes, across mails", async () => {
    const box = mailbox([mail(), mail({ id: "m2", text: "Your code is 111222" })]);
    expect(await waitForEmailCode([box], options(clocked()))).toEqual({ kind: "miss", why: "ambiguous" });
  });

  it("waits for a code that arrives late, and stops when one does", async () => {
    const time = clocked();
    const messages: ReturnType<typeof mail>[] = [];
    const late: CodeMailbox = { list: async () => { if (time.now() >= ASKED + 20_000) messages[0] = mail({ at: ASKED + 20_000 }); return messages; }, body: async () => messages[0]!.text };
    expect(await waitForEmailCode([late], options(time))).toEqual({ kind: "code", code: "483920" });
    expect(time.now()).toBeLessThan(ASKED + 30_000);
  });

  it("gives up after about a minute, saying nothing arrived", async () => {
    const time = clocked();
    expect(await waitForEmailCode([mailbox([])], options(time))).toEqual({ kind: "miss", why: "not-found" });
    expect(time.now() - ASKED).toBeGreaterThanOrEqual(60_000);
    expect(time.now() - ASKED).toBeLessThan(70_000);
  });

  it("falls back on a code already used", async () => {
    const box = mailbox([mail()]);
    expect(await waitForEmailCode([box], { ...options(clocked()), isUsed: (code) => code === "483920" })).toEqual({ kind: "miss", why: "used" });
  });

  it("stops looking once the turn has ended", async () => {
    const time = clocked();
    await waitForEmailCode([mailbox([])], { ...options(time), active: () => false });
    expect(time.now()).toBe(ASKED);
  });

  it("does not read a mailbox when the turn has already ended", async () => {
    const box = { list: vi.fn(async () => [mail()]), body: vi.fn(async () => mail().text) };
    expect(await waitForEmailCode([box], { ...options(clocked()), active: () => false })).toEqual({ kind: "miss", why: "not-found" });
    expect(box.list).not.toHaveBeenCalled();
    expect(box.body).not.toHaveBeenCalled();
  });

  it("does not read message bodies when the turn ends during the mailbox listing", async () => {
    let active = true;
    const box = {
      list: async () => { active = false; return [mail()]; },
      body: vi.fn(async () => mail().text),
    };
    expect(await waitForEmailCode([box], { ...options(clocked()), active: () => active })).toEqual({ kind: "miss", why: "not-found" });
    expect(box.body).not.toHaveBeenCalled();
  });

  it("discards a late code and reads no further messages after the turn ends", async () => {
    let active = true;
    const box = {
      list: async () => [mail(), mail({ id: "m2" })],
      body: vi.fn(async () => { active = false; return mail().text; }),
    };
    expect(await waitForEmailCode([box], { ...options(clocked()), active: () => active })).toEqual({ kind: "miss", why: "not-found" });
    expect(box.body).toHaveBeenCalledExactlyOnceWith("m1");
  });

  it("does not start another poll after the turn ends while waiting", async () => {
    let active = true;
    const box = { list: vi.fn(async () => []), body: vi.fn(async () => null) };
    expect(await waitForEmailCode([box], {
      ...options(clocked()), active: () => active, sleep: async () => { active = false; },
    })).toEqual({ kind: "miss", why: "not-found" });
    expect(box.list).toHaveBeenCalledTimes(1);
  });

  it("says the mailbox couldn't be read when every look fails", async () => {
    const broken: CodeMailbox = { list: async () => { throw new Error("signed out"); }, body: async () => null };
    expect(await waitForEmailCode([broken], options(clocked()))).toEqual({ kind: "miss", why: "unreadable" });
  });
});
