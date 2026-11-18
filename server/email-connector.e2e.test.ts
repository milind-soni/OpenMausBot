// The Email connector end to end against a real mail server (Postfix and Dovecot in Docker), so not in CI: a real server and
// its tools with the fake engine. A bot asks for the mailbox, the person types on its one card, the next turn's own proxy
// lists and reads real mail and sends a real message. Every recognisable value is then searched for in everything the
// server wrote and said. Run it as server/email/real-server.test.ts says.
import { randomBytes } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ADDRESS = "e2e@omb-test.example";
const PASSWORD = "fake pässword-with spaces 7";
const SERVER = { imapHost: "localhost", imapPort: 11993, smtpHost: "localhost", smtpPort: 11587 };
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(512), Buffer.from("\n%%EOF\n")]);
const MAIL = [
  ["From: =?UTF-8?Q?M=C3=BCller?= <hans@example.net>", `To: ${ADDRESS}`, "Subject: =?UTF-8?B?UmVjaG51bmcgZsO8ciBNw6RyeiDigJMgw5xiZXJ3ZWlzdW5nIOKckw==?=", "Date: Mon, 2 Nov 2026 10:00:00 +0100", "", "Hallo"].join("\r\n"),
  ["From: paren@example.net", `To: ${ADDRESS}`, "Subject: )", "Date: Mon, 2 Nov 2026 10:01:00 +0100", "", "a lone parenthesis"].join("\r\n"),
  ["From: invoices@example.net", `To: ${ADDRESS}`, "Subject: =?UTF-8?B?UmVjaG51bmcgTcOkcno=?=", "Date: Mon, 2 Nov 2026 10:02:00 +0100", "Message-ID: <invoice@example.net>", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain", "", "See the invoice.", "--b1", 'Content-Type: application/pdf; name="r.pdf"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="r.pdf"', "", PDF.toString("base64"), "--b1--", ""].join("\r\n"),
];

describe.skipIf(!process.env.OMB_EMAIL_REAL_TEST)("Email end to end", () => {
  let home = "", base = "", log = "";
  let child: ChildProcess;
  const said: string[] = [];
  const proxies: ChildProcess[] = [];
  const dump = () => JSON.parse(readFileSync(join(home, "spawn.json"), "utf8")) as { mcpConfig: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }; argv: string[] };

  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, { method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    said.push(text);
    return { status: response.status, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  }

  async function proxy(name: string) {
    const server = dump().mcpConfig.mcpServers[name]!;
    const process_ = spawn(server.command, server.args, { env: { PATH: process.env.PATH, HOME: home, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
    proxies.push(process_);
    const replies = new Map<number, (value: any) => void>();
    createInterface({ input: process_.stdout! }).on("line", (line) => { const message = JSON.parse(line); replies.get(message.id)?.(message.result); replies.delete(message.id); });
    let next = 0;
    const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => { const id = ++next; replies.set(id, resolve); process_.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
    await request("initialize", { protocolVersion: "2024-11-05" });
    return {
      call: async (tool: string, args: unknown = {}) => { const result = await request("tools/call", { name: tool, arguments: args }); said.push(JSON.stringify(result)); return { text: String(result.content?.[0]?.text ?? ""), isError: result.isError === true }; },
      list: () => request("tools/list", {}),
    };
  }

  beforeAll(async () => {
    const seed = new ImapFlow({ host: "localhost", port: SERVER.imapPort, secure: true, auth: { user: ADDRESS, pass: PASSWORD }, logger: false });
    seed.on("error", () => {});
    await seed.connect();
    const lock = await seed.getMailboxLock("INBOX");
    try {
      if ((seed.mailbox as { exists: number }).exists) await seed.messageDelete("1:*");
      for (const raw of MAIL) await seed.append("INBOX", Buffer.from(raw), []);
    } finally { lock.release(); await seed.logout(); }
    home = mkdtempSync(join(tmpdir(), "omb-email-e2e-"));
    const dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    const cli = join(home, "fixture-claude.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "spawn.json"))}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
      ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    } }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH, HOME: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    } });
    child.stdout?.on("data", (chunk) => { log += chunk; });
    child.stderr?.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 60_000);

  afterAll(async () => {
    for (const one of proxies) one.kill();
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  function filesHolding(root: string, needle: string): string[] {
    const found: string[] = [];
    const walk = (folder: string) => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        const info = lstatSync(path);
        if (info.isDirectory()) walk(path);
        else if (info.isFile() && readFileSync(path).includes(needle)) found.push(relative(root, path));
      }
    };
    walk(root);
    return found;
  }

  it("from a bot's ask to real mail read and sent, with the password in no record", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Postmeister", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
    const prompt = async () => (await api("GET", `/api/bots/${bot.id}/system-prompt`)).body.sections.find((section: { id: string }) => section.id === "email")?.text as string;
    expect(await prompt(), "before a mailbox: how to ask").toContain("credential_id email");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Hol meine Mails." })).status).toBe(202);
    await expect.poll(() => { try { return Boolean(dump().mcpConfig.mcpServers.agents); } catch { return false; } }, { timeout: 20_000 }).toBe(true);
    expect(dump().mcpConfig.mcpServers.email, "nothing to mount yet").toBeUndefined();

    const tools = await proxy("agents");
    expect((await tools.call("request_credential", { credential_id: "email", address: ADDRESS, reason: "To read today's mail." })).text).toMatch(/^A secure card for the mailbox is ready/u);
    const cards = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages.filter((message: { kind: string }) => message.kind === "secret");
    const card = (await cards()).at(-1);
    expect(card.secret).toMatchObject({ delivery: "email", address: ADDRESS, target: "customSecret" });
    const save = (fields: Record<string, unknown>) => api("POST", `/api/bots/${bot.id}/secret-cards/${card.id}/save`, { threadId: bot.threadId, ...fields });

    expect(await save({ value: "fake-wrong-password", ...SERVER })).toMatchObject({ status: 400, body: { error: expect.stringContaining("did not accept") } });
    expect((await cards()).at(-1).secret.provided, "the card stays open").toBeUndefined();
    expect((await api("GET", "/api/email")).body.state).toBe("signed-out");

    expect(await save({ value: PASSWORD, ...SERVER })).toMatchObject({ status: 200, body: { provided: true } });
    const status = (await api("GET", "/api/email")).body;
    expect(status).toMatchObject({ state: "connected", accounts: [{ address: ADDRESS, imapHost: "localhost", smtpHost: "localhost" }] });
    expect(await prompt()).toContain(ADDRESS);
    expect((await tools.call("request_credential", { credential_id: "email", address: ADDRESS })).text, "not asked twice").toContain("already connected");

    // A new conversation's turn gets the tools, through the same proxy every engine starts.
    const { task } = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Mail" })).body as { task: { threadId: string } };
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Und jetzt?", threadId: task.threadId })).status).toBe(202);
    await expect.poll(() => Boolean(dump().mcpConfig.mcpServers.email), { timeout: 20_000, interval: 200 }).toBe(true);
    expect(JSON.stringify(dump()), "the box gets a capability, never the password").not.toContain(PASSWORD);
    const allowed = dump().argv[dump().argv.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed).toContain("mcp__email__EMAIL_READ_MESSAGE");
    expect(allowed).not.toContain("mcp__email__EMAIL_SEND_MESSAGE");

    const mail = await proxy("email");
    expect((await mail.list()).tools.map((tool: { name: string }) => tool.name)).toEqual(["EMAIL_LIST_MAILBOXES", "EMAIL_LIST_MESSAGES", "EMAIL_SEARCH_MESSAGES", "EMAIL_READ_MESSAGE", "EMAIL_SEND_MESSAGE"]);
    const listed = await mail.call("EMAIL_LIST_MESSAGES", { limit: 50 });
    expect(listed.isError, listed.text).toBe(false);
    const messages = JSON.parse(listed.text).messages as Array<{ uid: number; subject: string }>;
    const tasks = (await api("GET", "/api/bots")).body.bots.find((one: { id: string }) => one.id === bot.id).tasks as Array<{ threadId: string; outside?: true }>;
    expect(tasks.find((one) => one.threadId === task.threadId)?.outside, "reading mail makes the conversation outside work").toBe(true);
    expect(messages.map((one) => one.subject)).toEqual(expect.arrayContaining(["Rechnung für März – Überweisung ✓", ")"]));
    const withPdf = messages.find((one) => one.subject === "Rechnung März")!;
    const read = JSON.parse((await mail.call("EMAIL_READ_MESSAGE", { uid: withPdf.uid, save_attachments: true })).text);
    expect(read.attachments[0]).toMatchObject({ contentType: "application/pdf" });
    expect(readFileSync(read.attachments[0].savedTo).subarray(0, 4).toString()).toBe("%PDF");
    expect((await mail.call("EMAIL_READ_MESSAGE", { uid: 999_999 })).isError).toBe(true);
    const sent = JSON.parse((await mail.call("EMAIL_SEND_MESSAGE", { to: [ADDRESS], subject: "From the bot ✓", text: "Grüße", reply_to_uid: withPdf.uid })).text);
    expect(sent).toMatchObject({ accepted: [ADDRESS], rejected: [], filed: true });
    expect((await mail.call("EMAIL_SEARCH_MESSAGES", { subject: "März" })).text).toContain("Rechnung");

    for (const where of [...said, log]) expect(where).not.toContain(PASSWORD);
    expect(filesHolding(home, PASSWORD), "sealed at rest, and in nothing else").toEqual([]);
  }, 180_000);
});
