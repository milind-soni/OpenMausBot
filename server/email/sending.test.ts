// Sending against a local mail submission server (server/testing/fake-smtp.ts) the way mail hosts run theirs: STARTTLS on
// a submission port with AUTH only once TLS is up, TLS from the first byte, AUTH LOGIN or PLAIN alone. Made-up names on
// loopback with a certificate for them; made-up passwords.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startFakeSmtp, testCertificate, trustTestCertificate, type FakeSmtp, type FakeSmtpOptions } from "../testing/fake-smtp.ts";
import { testSending, type EmailGuard } from "./client.ts";
import { createEmailHost } from "./host.ts";
import { createEmailService } from "./service.ts";
import type { EmailToolResult } from "./tools.ts";

const ADDRESS = "office@small-shop.example";
const PASSWORD = "fake-mailbox-password-1";
const OTHER = "fake-outgoing-password-2";
const HOST = "smtp.small-shop.example";
const certificate = testCertificate([HOST, "imap.small-shop.example"]);
/** Every made-up name is the fake on loopback; its certificate is for that name. */
const guard: EmailGuard = async ({ host }) => ({ host: "127.0.0.1", servername: host });
const plain = (user: string, password: string) => Buffer.from(`\0${user}\0${password}`).toString("base64");

const servers: FakeSmtp[] = [];
const dirs: string[] = [];
let untrust = () => {};
beforeAll(() => { if (certificate) untrust = trustTestCertificate(certificate.cert); });
afterAll(() => untrust());
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fake(options: Partial<FakeSmtpOptions> = {}): Promise<FakeSmtp> {
  const server = await startFakeSmtp({ certificate: certificate!, security: "starttls", mechanisms: ["PLAIN", "LOGIN"], users: { [ADDRESS]: PASSWORD }, ...options });
  servers.push(server);
  return server;
}

describe.skipIf(!certificate)("an outgoing server, over the wire", () => {
  it("587's way: plain until STARTTLS, a sign-in only after it, and the password never in the clear", async () => {
    const smtp = await fake();
    await testSending({ username: ADDRESS, password: PASSWORD }, { host: HOST, port: smtp.port, secure: false }, guard);
    expect(smtp.signIns).toEqual([{ mechanism: "PLAIN", user: ADDRESS, ok: true }]);
    expect(smtp.plain.some((line) => /^STARTTLS/iu.test(line))).toBe(true);
    expect(smtp.plain.join("\n")).not.toContain(plain(ADDRESS, PASSWORD));
    expect(smtp.plain.some((line) => /^AUTH/iu.test(line))).toBe(false);
  }, 20_000);

  it("465's way: TLS from the first byte", async () => {
    const smtp = await fake({ security: "tls" });
    await testSending({ username: ADDRESS, password: PASSWORD }, { host: HOST, port: smtp.port, secure: true }, guard);
    expect(smtp.signIns).toEqual([{ mechanism: "PLAIN", user: ADDRESS, ok: true }]);
    expect(smtp.plain).toEqual([]);
  }, 20_000);

  it("signs in with AUTH LOGIN where that is all a server offers, and with AUTH PLAIN where that is", async () => {
    const login = await fake({ mechanisms: ["LOGIN"] });
    await testSending({ username: ADDRESS, password: PASSWORD }, { host: HOST, port: login.port, secure: false }, guard);
    expect(login.signIns).toEqual([{ mechanism: "LOGIN", user: ADDRESS, ok: true }]);
    const onlyPlain = await fake({ security: "tls", mechanisms: ["PLAIN"] });
    await testSending({ username: ADDRESS, password: PASSWORD }, { host: HOST, port: onlyPlain.port, secure: true }, guard);
    expect(onlyPlain.signIns).toEqual([{ mechanism: "PLAIN", user: ADDRESS, ok: true }]);
  }, 20_000);

  it("a refused password is said in one plain sentence naming the server", async () => {
    const smtp = await fake();
    await expect(testSending({ username: ADDRESS, password: "fake-wrong-password" }, { host: HOST, port: smtp.port, secure: false }, guard))
      .rejects.toMatchObject({ fault: "password", message: `The outgoing server ${HOST}:${smtp.port} refused the password.` });
  }, 20_000);

  it("no password goes to a server that doesn't take one, and none at all without a login", async () => {
    const smtp = await fake();
    await testSending(null, { host: HOST, port: smtp.port, secure: false }, guard);
    expect(smtp.signIns).toEqual([]);
  }, 20_000);

  it("TLS from the first byte on a port that starts in the clear: said as the mix-up it is", async () => {
    const smtp = await fake();
    await expect(testSending({ username: ADDRESS, password: PASSWORD }, { host: HOST, port: smtp.port, secure: true }, guard))
      .rejects.toMatchObject({ fault: "wrong-security", message: expect.stringContaining("choose STARTTLS for it, not SSL/TLS") });
    expect(smtp.signIns).toEqual([]);
  }, 20_000);

  it("STARTTLS on a port that starts in TLS: the greeting never comes, and that is said as the mix-up too", async () => {
    const smtp = await fake({ security: "tls" });
    await expect(testSending({ username: ADDRESS, password: PASSWORD }, { host: HOST, port: smtp.port, secure: false }, guard))
      .rejects.toMatchObject({ fault: "wrong-security", message: expect.stringContaining("expects SSL/TLS from the first byte") });
    expect(smtp.signIns).toEqual([]);
  }, 30_000);
});

describe.skipIf(!certificate)("connecting, checking and sending through the fake", () => {
  function setup(smtp: FakeSmtp, socketType: "STARTTLS" | "SSL") {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mail-sending-")); dirs.push(dataDir);
    const autoconfig = `<clientConfig><emailProvider id="x">
      <incomingServer type="imap"><hostname>imap.small-shop.example</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
      <outgoingServer type="smtp"><hostname>${HOST}</hostname><port>${smtp.port}</port><socketType>${socketType}</socketType><username>%EMAILADDRESS%</username></outgoingServer>
    </emailProvider></clientConfig>`;
    const service = createEmailService({
      dataDir, publicOnly: false, guard,
      discover: { fetchText: async (url) => (url.startsWith("https://autoconfig.small-shop.example/") ? autoconfig : null), mx: async () => [], srv: async () => [], cname: async () => [], reverse: async () => [] },
      // Reading is a stand-in; sending is the real client.
      test: { mailbox: (async () => ({ messages: 1 })) as never, sending: testSending },
    });
    const host = createEmailHost({ service, dataDir, bot: () => ({ id: "b1", name: "Ada", color: "blue" }), inRoom: () => false, appendMessage: () => {}, markOutside: () => {} });
    const call = (name: string, args: Record<string, unknown>) => host.handle({ method: "tools/call", params: { name, arguments: args } }, { botId: "b1", threadId: "t1" }, () => {}) as Promise<EmailToolResult>;
    return { service, call };
  }

  it("connect keeps the outgoing server that took the password, and the email tool sends from the address", async () => {
    const smtp = await fake();
    const { service, call } = setup(smtp, "STARTTLS");
    expect(await service.connect({ address: ADDRESS, password: PASSWORD })).toMatchObject({ ok: true, sending: { ok: true }, account: { smtpHost: HOST, smtpPort: smtp.port, smtpSecurity: "starttls" } });
    const sent = await call("EMAIL_SEND_MESSAGE", { to: ["someone@example.net"], subject: "Hello", text: "Body" });
    expect(sent.isError, sent.content[0]?.text).toBeUndefined();
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]).toMatchObject({ from: ADDRESS, to: ["someone@example.net"] });
    expect(smtp.received[0]!.data).toContain(`From: ${ADDRESS}`);
  }, 30_000);

  it("reading that works with sending that doesn't is saved saying why; the outgoing server typed later is checked alone, and a test goes to the address", async () => {
    const smtp = await fake({ security: "tls", users: { [ADDRESS]: OTHER } });
    const { service, call } = setup(smtp, "SSL");
    const answer = await service.connect({ address: ADDRESS, password: PASSWORD });
    const refused = `The outgoing server ${HOST}:${smtp.port} refused the password.`;
    expect(answer).toMatchObject({ ok: true, sending: { ok: false, problem: refused }, account: { sendingProblem: refused, smtpTried: { smtpHost: HOST, smtpPort: smtp.port, smtpSecurity: "tls" } } });
    expect(answer.ok && answer.account.smtpHost).toBeFalsy();
    const refusedSend = await call("EMAIL_SEND_MESSAGE", { to: ["someone@example.net"], subject: "Hello", text: "Body" });
    expect(refusedSend).toMatchObject({ isError: true });
    expect(refusedSend.content[0]?.text).toContain(refused);
    expect(refusedSend.content[0]?.text).toContain("Don't retry");

    const signIns = smtp.signIns.length;
    expect(await service.checkOutgoing(ADDRESS, { smtpHost: HOST, smtpPort: smtp.port, smtpSecurity: "tls", smtpPassword: OTHER })).toMatchObject({ ok: true, account: { smtpHost: HOST, smtpPort: smtp.port } });
    expect(smtp.signIns.slice(signIns)).toEqual([{ mechanism: "PLAIN", user: ADDRESS, ok: true }]);
    expect(service.store.get(ADDRESS)).toMatchObject({ password: PASSWORD, smtpPassword: OTHER });
    expect(service.status().accounts[0]!.sendingProblem).toBeUndefined();

    expect(await service.sendTest(ADDRESS)).toEqual({ ok: true });
    expect(smtp.received.at(-1)).toMatchObject({ from: ADDRESS, to: [ADDRESS] });
    expect(service.scrub(`a ${OTHER} b`)).not.toContain(OTHER);
  }, 30_000);

  it("a mix-up typed by hand is said as one and nothing is saved over it", async () => {
    const smtp = await fake();
    const { service } = setup(smtp, "STARTTLS");
    await service.connect({ address: ADDRESS, password: PASSWORD });
    expect(await service.checkOutgoing(ADDRESS, { smtpHost: HOST, smtpPort: smtp.port, smtpSecurity: "tls" })).toMatchObject({ ok: false, error: expect.stringContaining("choose STARTTLS") });
    expect(service.store.get(ADDRESS)?.smtp).toEqual({ host: HOST, port: smtp.port, secure: false });
  }, 30_000);
});
