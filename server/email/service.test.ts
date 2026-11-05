import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EmailError, openGuard } from "./client.ts";
import type { DiscoverDeps } from "./discover.ts";
import { createEmailService } from "./service.ts";
import { MAX_EMAIL_ACCOUNTS } from "./store.ts";

const PASSWORD = "fake-mailbox-password-1";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOWHERE: DiscoverDeps = { fetchText: async () => null, mx: async () => [], srv: async () => [] };

function service(mailbox: (imap: { host: string; port: number }, username: string, password: string) => { messages: number; newest?: { from: string; subject: string } } | EmailError, sending: (host: string) => EmailError | void = () => {}, more: { refusal?: string; dataDir?: string } = {}) {
  const dataDir = more.dataDir ?? mkdtempSync(join(tmpdir(), "omb-mail-service-")); if (!more.dataDir) dirs.push(dataDir);
  const tried: string[] = [];
  const sent: string[] = [];
  const email = createEmailService({ dataDir, publicOnly: false, ...(more.refusal ? { refusal: more.refusal } : {}), discover: NOWHERE, guard: openGuard, test: {
    mailbox: (async (account: { username: string; password: string; imap: { host: string; port: number } }) => { tried.push(`${account.imap.host}:${account.imap.port}:${account.username}`); const answer = mailbox(account.imap, account.username, account.password); if (answer instanceof EmailError) throw answer; return answer; }) as never,
    sending: (async (_account: unknown, server: { host: string; port: number }) => { sent.push(`${server.host}:${server.port}`); const answer = sending(server.host); if (answer) throw answer; }) as never,
  } });
  return { email, tried, sent, dataDir };
}
const NO_ANSWER = () => new EmailError("network", "no");
const WRONG = () => new EmailError("password", "no");

describe("connecting a mailbox", () => {
  it("keeps nothing until a real header has been read back, and then says what it read", async () => {
    const { email } = service((imap) => (imap.host === "imap.shop.example" ? { messages: 30, newest: { from: "Ada", subject: "Hi" } } : NO_ANSWER()));
    const answer = await email.connect({ address: "me@shop.example", password: PASSWORD });
    expect(answer).toMatchObject({ ok: true, inbox: { messages: 30, newest: { from: "Ada", subject: "Hi" } }, account: { address: "me@shop.example", imapHost: "imap.shop.example", smtpHost: "smtp.shop.example" }, sending: { ok: true } });
    expect(email.status()).toMatchObject({ state: "connected", accounts: [{ address: "me@shop.example" }] });
    expect(JSON.stringify(answer)).not.toContain(PASSWORD);
    expect(JSON.stringify(email.status())).not.toContain(PASSWORD);
  });

  it("a mailbox whose headers can't be read is not connected", async () => {
    const { email } = service(() => new EmailError("server", "The mailbox opened, but its messages' headers could not be read."));
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD, imapHost: "imap.shop.example" })).toMatchObject({ ok: false, needsServer: true });
    expect(email.status().state).toBe("signed-out");
  });

  it("a refused password stops there: it goes to no other host, and the person is told plainly", async () => {
    const { email, tried } = service(WRONG);
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toEqual({ ok: false, error: "The mail server did not accept this address and password. Check them and try again." });
    expect(tried).toEqual(["imap.shop.example:993:me@shop.example", "imap.shop.example:993:me"]);
    expect(email.status().state).toBe("signed-out");
  });

  it("a host that takes the short name works", async () => {
    const { email } = service((_imap, username) => (username === "me" ? { messages: 1 } : WRONG()));
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: true });
    expect(email.store.get("me@shop.example")?.username).toBe("me");
  });

  it("the big providers' password rules are said in words", async () => {
    const { email } = service(WRONG);
    expect(await email.connect({ address: "me@gmail.com", password: PASSWORD })).toMatchObject({ ok: false, error: expect.stringContaining("app password") });
    expect(await email.connect({ address: "me@outlook.com", password: PASSWORD })).toMatchObject({ ok: false, error: expect.stringContaining("Microsoft") });
  });

  it("nothing found asks for the server, and a typed one is used alone", async () => {
    const { email, tried, sent } = service((imap) => (imap.host === "post.hoster.example" ? { messages: 2 } : NO_ANSWER()));
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: false, needsServer: true });
    tried.length = 0;
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD, imapHost: "post.hoster.example", smtpHost: "out.hoster.example", smtpPort: 2525, username: "m1" })).toMatchObject({ ok: true });
    expect(tried).toEqual(["post.hoster.example:993:m1"]);
    expect(sent).toEqual(["out.hoster.example:2525"]);
  });

  it("a typed port says how it speaks TLS: the well-known ports as they are, any other tried in TLS first, then upgraded", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mail-service-")); dirs.push(dataDir);
    const email = createEmailService({ dataDir, publicOnly: false, discover: NOWHERE, guard: openGuard, test: {
      mailbox: (async (account: { imap: Record<string, unknown> }) => { seen.push(account.imap); return { messages: 1 }; }) as never,
      sending: (async (_account: unknown, server: Record<string, unknown>) => { seen.push(server); }) as never,
    } });
    for (const [imapPort, smtpPort] of [[993, 465], [143, 587], [10143, 2525]]) await email.connect({ address: "me@shop.example", password: PASSWORD, imapHost: "a.example", imapPort, smtpHost: "b.example", smtpPort });
    expect(seen.map((server) => [server.port, server.secure])).toEqual([[993, true], [465, true], [143, false], [587, false], [10143, true], [2525, true]]);
  });

  it("reading can work while sending doesn't, and it says so", async () => {
    const { email } = service(() => ({ messages: 2 }), () => NO_ANSWER());
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toMatchObject({ ok: true, sending: { ok: false, problem: "No outgoing mail server answered." } });
    expect(email.status().accounts[0]).toMatchObject({ problem: expect.stringContaining("Reading works") });
    expect(email.store.get("me@shop.example")?.smtp).toBeUndefined();
  });

  it("refuses what isn't an address or a host, and more mailboxes than it keeps", async () => {
    const { email } = service(() => ({ messages: 1 }));
    expect(await email.connect({ address: "not an address", password: PASSWORD })).toMatchObject({ ok: false });
    expect(await email.connect({ address: "me@shop.example", password: "" })).toMatchObject({ ok: false });
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD, imapHost: "bad host;x" })).toMatchObject({ ok: false, needsServer: true });
    for (let n = 0; n < MAX_EMAIL_ACCOUNTS; n++) expect((await email.connect({ address: `m${n}@shop.example`, password: PASSWORD })).ok).toBe(true);
    expect(await email.connect({ address: "more@shop.example", password: PASSWORD })).toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_EMAIL_ACCOUNTS)) });
    expect((await email.connect({ address: "m0@shop.example", password: `${PASSWORD}-new` })).ok, "the same address is replaced").toBe(true);
  });

  it("on a Cloud home reaches only the public internet, whatever host is typed, and never tries the password elsewhere", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mail-service-")); dirs.push(dataDir);
    const cloud = createEmailService({ dataDir, publicOnly: true, discover: NOWHERE });
    for (const imapHost of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "localhost"]) {
      expect(await cloud.connect({ address: "me@shop.example", password: PASSWORD, imapHost }), imapHost).toEqual({ ok: false, needsServer: true, error: "My Cloud can only reach mail servers on the public internet." });
    }
    expect(cloud.status().state).toBe("signed-out");
  }, 30_000);

  it("is off where a place refuses it", async () => {
    const { email, tried } = service(() => ({ messages: 1 }), undefined, { refusal: "Not here." });
    expect(email.status()).toEqual({ state: "unavailable", accounts: [], reason: "Not here." });
    expect(await email.connect({ address: "me@shop.example", password: PASSWORD })).toEqual({ ok: false, error: "Not here." });
    expect(tried).toEqual([]);
    expect(email.mounted()).toBe(false);
  });

  it("rests sealed: no password in any file, owner-only, and back after a restart", async () => {
    const { email, dataDir } = service(() => ({ messages: 1 }));
    await email.connect({ address: "me@shop.example", password: PASSWORD });
    for (const name of readdirSync(dataDir)) {
      expect(readFileSync(join(dataDir, name)).toString("latin1"), name).not.toContain(PASSWORD);
      // Windows has no POSIX mode bits; its files are private to the user by their folder.
      if (process.platform !== "win32") expect(statSync(join(dataDir, name)).mode & 0o077, name).toBe(0);
    }
    expect(service(() => ({ messages: 1 }), undefined, { dataDir }).email.store.get("me@shop.example")?.password).toBe(PASSWORD);
  });

  it("masks a saved password in whatever a bot or a transcript reads, in any form", async () => {
    const { email } = service(() => ({ messages: 1 }));
    await email.connect({ address: "me@shop.example", password: "p&ss w<rd" });
    expect(email.scrub("before p&ss w<rd after")).not.toContain("p&ss w<rd");
    expect(email.scrub(encodeURIComponent("p&ss w<rd"))).not.toContain("w%3Crd");
    expect(email.scrub("nothing here")).toBe("nothing here");
  });

  it("takes mailboxes moved from a computer, keeping one already here", async () => {
    const { email } = service(() => ({ messages: 1 }));
    await email.connect({ address: "here@shop.example", password: "fake-here-password" });
    const moved = (address: string) => ({ address, username: address, password: PASSWORD, imap: { host: "imap.shop.example", port: 993, secure: true }, connectedAt: 1 });
    expect(email.adopt([moved("here@shop.example"), moved("new@shop.example"), { address: "broken" }])).toEqual({ adopted: 1, kept: 1 });
    expect(email.store.get("here@shop.example")?.password).toBe("fake-here-password");
    expect(email.store.get("new@shop.example")?.password).toBe(PASSWORD);
  });
});
