// A loopback mail submission server, shaped like the ones mail hosts run: STARTTLS on a submission port or TLS from
// the first byte, AUTH PLAIN and/or LOGIN, offered before or only after STARTTLS. Its certificate is one made for the
// test (openssl, two days), valid for the names the test asks for, which the test's process trusts as a mail program
// trusts a public one.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, getCACertificates, setDefaultCACertificates, TLSSocket, type SecureContext } from "node:tls";

export interface TestCertificate { key: string; cert: string }

/** A self-signed certificate for `names`, or undefined where no openssl runs. */
export function testCertificate(names: string[]): TestCertificate | undefined {
  const dir = mkdtempSync(join(tmpdir(), "omb-fake-smtp-cert-"));
  try {
    // A config of its own, so no system openssl.cnf is needed (Windows).
    writeFileSync(join(dir, "openssl.cnf"), [
      "[req]", "distinguished_name = dn", "x509_extensions = v3", "prompt = no",
      "[dn]", "CN = OpenMausBot fake mail",
      "[v3]", "basicConstraints = critical,CA:TRUE", "keyUsage = critical,digitalSignature,keyCertSign",
      "extendedKeyUsage = serverAuth", `subjectAltName = ${names.map((name) => `DNS:${name}`).join(",")}`, "",
    ].join("\n"));
    const made = spawnSync("openssl", ["req", "-x509", "-config", join(dir, "openssl.cnf"), "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2"], { stdio: "pipe", timeout: 30_000 });
    if (made.error || made.status !== 0) return undefined;
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Trusts `cert` in this process until the returned function puts the trusted list back. */
export function trustTestCertificate(cert: string): () => void {
  const before = getCACertificates("default");
  setDefaultCACertificates([...before, cert]);
  return () => setDefaultCACertificates(before);
}

export interface FakeSmtpOptions {
  certificate: TestCertificate;
  /** "tls": TLS from the first byte (port 465's way); "starttls": plain until STARTTLS (port 587's way). */
  security: "tls" | "starttls";
  mechanisms: Array<"PLAIN" | "LOGIN">;
  /** Offer AUTH before STARTTLS too; most hosts offer it only after. */
  authBeforeTls?: boolean;
  /** Leave STARTTLS out of the plain EHLO answer. */
  noStarttls?: boolean;
  /** user name to password */
  users: Record<string, string>;
}

export interface FakeSmtp {
  port: number;
  /** What came over the wire before TLS, as text. */
  plain: string[];
  signIns: Array<{ mechanism: string; user: string; ok: boolean }>;
  received: Array<{ from: string; to: string[]; data: string }>;
  close(): void;
}

export async function startFakeSmtp(options: FakeSmtpOptions): Promise<FakeSmtp> {
  const context: SecureContext = createSecureContext({ key: options.certificate.key, cert: options.certificate.cert, minVersion: "TLSv1.2" });
  const fake: Omit<FakeSmtp, "port" | "close"> = { plain: [], signIns: [], received: [] };
  const sockets = new Set<Socket>();

  const session = (raw: Socket) => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    raw.on("error", () => {});
    let socket: Socket = raw;
    let secure = false;
    let user: string | null = null;
    let buffer = "";
    let pending: ((line: string) => void) | null = null;
    let mail: { from: string; to: string[]; data: string } | null = null;
    let inData = false;
    const say = (text: string) => { if (!socket.destroyed) socket.write(`${text}\r\n`); };
    const decode = (value: string) => Buffer.from(value, "base64").toString("utf8");
    const signIn = (mechanism: string, name: string, password: string) => {
      const ok = Object.hasOwn(options.users, name) && options.users[name] === password;
      fake.signIns.push({ mechanism, user: name, ok });
      if (ok) { user = name; say("235 2.7.0 Authentication successful"); } else say("535 5.7.8 Authentication credentials invalid");
    };
    const ehlo = () => {
      const lines = ["fake.mail.test", "PIPELINING", "8BITMIME", "SIZE 10485760"];
      if (!secure && !options.noStarttls && options.security === "starttls") lines.push("STARTTLS");
      if (secure || options.authBeforeTls) lines.push(`AUTH ${options.mechanisms.join(" ")}`);
      lines.forEach((line, index) => say(`250${index === lines.length - 1 ? " " : "-"}${line}`));
    };
    const line = (text: string) => {
      if (!secure) fake.plain.push(text);
      if (inData) {
        if (text === ".") { inData = false; fake.received.push(mail!); mail = null; say("250 2.0.0 Ok: queued"); } else mail!.data += `${text.startsWith("..") ? text.slice(1) : text}\n`;
        return;
      }
      if (pending) { const next = pending; pending = null; next(text); return; }
      const [verb = "", ...rest] = text.split(" ");
      const argument = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO": ehlo(); return;
        case "HELO": say("250 fake.mail.test"); return;
        case "STARTTLS": {
          if (secure || options.noStarttls || options.security !== "starttls") { say("502 5.5.1 Not here"); return; }
          say("220 2.0.0 Ready to start TLS");
          raw.removeAllListeners("data");
          const upgraded = new TLSSocket(raw, { isServer: true, secureContext: context });
          upgraded.on("error", () => {});
          upgraded.on("secure", () => { secure = true; });
          socket = upgraded;
          buffer = "";
          listen(upgraded);
          return;
        }
        case "AUTH": {
          const [mechanism = "", initial] = argument.split(" ");
          const offered = (secure || options.authBeforeTls) && (options.mechanisms as string[]).includes(mechanism.toUpperCase());
          if (!offered) { say("504 5.5.4 Unrecognized authentication type"); return; }
          if (mechanism.toUpperCase() === "PLAIN") {
            const plain = (value: string) => { const [, name = "", password = ""] = decode(value).split("\0"); signIn("PLAIN", name, password); };
            if (initial) plain(initial); else { say("334 "); pending = plain; }
          } else {
            say(`334 ${Buffer.from("Username:").toString("base64")}`);
            pending = (name) => { say(`334 ${Buffer.from("Password:").toString("base64")}`); pending = (password) => signIn("LOGIN", decode(name), decode(password)); };
          }
          return;
        }
        case "MAIL":
          if (!user) { say("530 5.7.0 Authentication required"); return; }
          mail = { from: /<([^>]*)>/u.exec(argument)?.[1] ?? "", to: [], data: "" };
          say("250 2.1.0 Ok");
          return;
        case "RCPT":
          if (!mail) { say("503 5.5.1 MAIL first"); return; }
          mail.to.push(/<([^>]*)>/u.exec(argument)?.[1] ?? "");
          say("250 2.1.5 Ok");
          return;
        case "DATA":
          if (!mail?.to.length) { say("503 5.5.1 RCPT first"); return; }
          inData = true;
          say("354 End data with <CR><LF>.<CR><LF>");
          return;
        case "RSET": mail = null; say("250 2.0.0 Ok"); return;
        case "NOOP": say("250 2.0.0 Ok"); return;
        case "QUIT": say("221 2.0.0 Bye"); socket.end(); return;
        default: say("502 5.5.2 Error: command not recognized");
      }
    };
    const listen = (stream: Socket) => {
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let at = buffer.indexOf("\r\n"); at >= 0; at = buffer.indexOf("\r\n")) { const text = buffer.slice(0, at); buffer = buffer.slice(at + 2); line(text); }
      });
    };
    if (options.security === "tls") {
      const wrapped = new TLSSocket(raw, { isServer: true, secureContext: context });
      wrapped.on("error", () => {});
      socket = wrapped;
      secure = true;
      listen(wrapped);
    } else listen(raw);
    say("220 fake.mail.test ESMTP ready");
  };

  const server: Server = createServer(session);
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return { port, ...fake, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}
