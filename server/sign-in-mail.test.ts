import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createEmailSignIn } from "./account-signin.ts";
import { createSignInMail, SIGNIN_CODE_RESEND_MS, SIGNIN_CODE_TRIES, SIGNIN_CODE_TTL_MS, smtpOptions, type MailMessage } from "./sign-in-mail.ts";

const URL_ = "smtps://signin%40example.test:p%40ss@smtp.example.test:465";

function mailbox() {
  const sent: MailMessage[] = [];
  return { sent, transport: { sendMail: async (message: MailMessage) => { sent.push(message); } }, code: () => /(\d{4}) (\d{4})/.exec(sent.at(-1)!.text)!.slice(1).join("") };
}

describe("sign-in codes through the server's own mail server", () => {
  it("reads TLS, port and the URL-encoded login from the address, and requires STARTTLS off this machine", () => {
    expect(smtpOptions(URL_)).toMatchObject({ host: "smtp.example.test", port: 465, secure: true, requireTLS: false, auth: { user: "signin@example.test", pass: "p@ss" } });
    expect(smtpOptions("smtp://u:p@mail.example.test")).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(smtpOptions("smtp://localhost:25")).toMatchObject({ port: 25, requireTLS: false });
    expect(smtpOptions("smtp://localhost:25")).not.toHaveProperty("auth");
    expect(() => smtpOptions("https://smtp.example.test")).toThrow("smtps:// or smtp://");
    expect(() => smtpOptions("not a url")).toThrow("not a URL");
  });

  it("sends an 8-digit code that works once, and never says it in the subject", async () => {
    const box = mailbox();
    const mail = createSignInMail({ url: URL_, transport: box.transport });
    expect(await mail.send("her@example.test")).toBe("sent");
    expect(box.sent[0]).toMatchObject({ from: "signin@example.test", to: "her@example.test", subject: "Your MausBot sign-in code" });
    const code = box.code();
    expect(code).toMatch(/^\d{8}$/);
    expect(mail.check("other@example.test", code)).toBe("wrong");
    expect(mail.check("her@example.test", `${code.slice(0, 4)} ${code.slice(4)}`)).toBe("ok");
    expect(mail.check("her@example.test", code)).toBe("wrong");
    expect(mail.check("her@example.test", "12")).toBe("format");
  });

  it("names the server the code signs in to in the subject", async () => {
    const box = mailbox();
    await createSignInMail({ url: URL_, transport: box.transport }).send("her@example.test", "maus.example.com");
    expect(box.sent[0]).toMatchObject({ subject: "Your MausBot sign-in code for maus.example.com" });
    expect(box.sent[0]?.text).toContain("to sign in to maus.example.com is");
  });

  it("ends a code after ten minutes or five wrong tries, and sends at most one every 30 seconds", async () => {
    let clock = 1_000_000;
    const box = mailbox();
    const mail = createSignInMail({ url: URL_, from: "Sign-in <signin@example.test>", now: () => clock, transport: box.transport });
    await mail.send("her@example.test");
    expect(box.sent[0]!.from).toBe("Sign-in <signin@example.test>");
    expect(await mail.send("her@example.test")).toBe("tooSoon");
    clock += SIGNIN_CODE_RESEND_MS;
    expect(await mail.send("her@example.test")).toBe("sent");
    const code = box.code();
    const wrong = code === "00000000" ? "11111111" : "00000000";
    for (let attempt = 1; attempt < SIGNIN_CODE_TRIES; attempt++) expect(mail.check("her@example.test", wrong)).toBe("wrong");
    expect(mail.check("her@example.test", wrong)).toBe("tooMany");
    expect(mail.check("her@example.test", code)).toBe("wrong");
    clock += SIGNIN_CODE_RESEND_MS;
    await mail.send("her@example.test");
    clock += SIGNIN_CODE_TTL_MS;
    expect(mail.check("her@example.test", box.code())).toBe("wrong");
  });

  it("forgets a code the mail server refused, and needs a sender address", async () => {
    let refuse = true;
    const sent: MailMessage[] = [];
    const mail = createSignInMail({ url: URL_, transport: { sendMail: async (message) => { if (refuse) throw new Error("550 relay denied"); sent.push(message); } } });
    await expect(mail.send("her@example.test")).rejects.toThrow("550");
    refuse = false;
    expect(await mail.send("her@example.test")).toBe("sent");
    await expect(createSignInMail({ url: "smtp://localhost:25", transport: { sendMail: async () => undefined } }).send("her@example.test"))
      .rejects.toThrow("OMB_SIGNIN_SMTP_FROM");
  });

  it("is what email sign-in uses when OMB_SIGNIN_SMTP_URL is set: no account service, the allow-list as before", async () => {
    const box = mailbox();
    const signIn = createEmailSignIn({
      allow: { admins: ["her@example.test"], members: ["@team.test"] },
      env: { OMB_SIGNIN_SMTP_URL: URL_, OMB_CONTROL_PLANE_URL: "https://control-plane.invalid" },
      fetchImpl: async () => { throw new Error("the account service must not be asked"); },
      mailTransport: box.transport,
    });
    expect(await signIn.start("nobody@example.test")).toMatchObject({ ok: false, status: 403 });
    expect(box.sent).toEqual([]);
    expect(await signIn.start("Her@Example.test")).toEqual({ ok: true });
    expect(await signIn.start("her@example.test")).toMatchObject({ ok: false, status: 429 });
    expect(await signIn.verify("her@example.test", "1")).toMatchObject({ ok: false, status: 400 });
    expect(await signIn.verify("her@example.test", box.code() === "00000000" ? "11111111" : "00000000")).toMatchObject({ ok: false, status: 401 });
    expect(await signIn.verify("her@example.test", box.code())).toEqual({ ok: true, email: "her@example.test", userId: "email:her@example.test", scopes: ["admin", "client"] });
    await signIn.start("someone@team.test");
    expect(await signIn.verify("someone@team.test", box.code())).toMatchObject({ ok: true, scopes: ["client"] });
  });

  it("says why when the mail server cannot be used", async () => {
    const signIn = createEmailSignIn({ allow: { admins: ["her@example.test"], members: [] }, env: { OMB_SIGNIN_SMTP_URL: "smtp://localhost:25" } });
    const refused = await signIn.start("her@example.test");
    expect(refused).toMatchObject({ ok: false, status: 502 });
    expect(refused.ok ? "" : refused.error).toContain("OMB_SIGNIN_SMTP_FROM");
  });
});

describe("a real SMTP conversation", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it("delivers the code to a mail server on this machine through nodemailer", async () => {
    const received: string[] = [];
    server = createServer((socket) => {
      let data = false;
      let buffer = "";
      socket.write("220 fake.local ESMTP\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let end: number;
        while ((end = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (data) {
            if (line === ".") { data = false; socket.write("250 queued\r\n"); } else received.push(line);
            continue;
          }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO") socket.write("250-fake.local\r\n250 8BITMIME\r\n");
          else if (verb === "DATA") { data = true; socket.write("354 go on\r\n"); }
          else if (verb === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((ready) => server!.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;
    const mail = createSignInMail({ url: `smtp://127.0.0.1:${port}`, from: "signin@example.test" });
    expect(await mail.send("her@example.test")).toBe("sent");
    const message = received.join("\n");
    expect(message).toContain("To: her@example.test");
    const code = /(\d{4}) (\d{4})/.exec(message)!.slice(1).join("");
    expect(mail.check("her@example.test", code)).toBe("ok");
  });
});
