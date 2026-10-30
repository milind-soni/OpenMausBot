// A happy-dom page behind a stand-in agent-browser: nothing reaches a real browser, the user's data or port 8799.
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";
import { freePortBlock } from "./testing/ports.ts";

// Obvious fakes only.
const PASSWORD = "fake-E2E-Passw0rd!";
const USERNAME = "alice@example.com";
const INVOICES = { url: "https://example.com/invoices", html: "<title>Invoices</title><h1>March invoices</h1>" };

/** The bridge plays the running browser: the stand-in engine forwards each command, relay command and MCP call here. */
/** `cuaRecord`: the desktop app's driver record, handed to this server as the app hands it to its own. */
async function browserFixture(url: string, cuaRecord?: string) {
  const page = new FakeLoginPage(url, LOGIN_FORM);
  const port = await freePortBlock([0], 19_960, 40);
  const engineArgs: string[][] = [];
  // The proxy each browser command carries (a version probe starts no browser): a bot's browser goes through its egress gate.
  const proxies = new Set<string>();
  const bridge = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const reply = (data: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      if (req.url === "/api/command") {
        const command = JSON.parse(raw) as { action?: string; subaction?: string; text?: string; key?: string; selector?: string };
        if (command.action === "keyboard" && command.subaction === "insertText" && typeof command.text === "string") await page.insertText(command.text);
        else if (command.action === "press" && typeof command.key === "string") await page.press(command.key);
        else if (command.action === "click" && typeof command.selector === "string") await page.click(command.selector);
        else return reply({ success: false });
        return reply({ success: true, data: {} });
      }
      if (req.url === "/mcp") {
        const call = JSON.parse(raw) as { name: string; arguments?: { script?: string } };
        if (call.name === "agent_browser_get_url") return reply({ content: [{ type: "text", text: page.window.location.href }] });
        if (call.name === "agent_browser_eval") return reply({ content: [{ type: "text", text: JSON.stringify(page.window.eval(call.arguments?.script ?? "")) }] });
        return reply({ isError: true, content: [{ type: "text", text: `unknown tool ${call.name}` }] });
      }
      const { args, proxy } = JSON.parse(raw) as { args: string[]; proxy?: string };
      engineArgs.push(args);
      if (args[0] !== "--version") proxies.add(proxy ?? "none");
      const data = await page.engine(args);
      return reply({ success: true, data: data && "port" in data ? { ...data, port } : data });
    } catch (error) {
      return reply({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((ready) => bridge.listen(port, "127.0.0.1", ready));

  const tools = mkdtempSync(join(tmpdir(), "omb-saved-login-e2e-"));
  const binaryPath = join(tools, "agent-browser");
  // The stand-in agent-browser: always running, `close` and `set` do nothing, `mcp` answers get_url and eval from the
  // page, and every other command goes to the bridge.
  writeFileSync(binaryPath, `#!${process.execPath}
const args = process.argv.slice(2).filter((arg) => arg !== "--json" && arg !== "--no-webmcp");
const say = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const bridge = (path, body) => fetch("http://127.0.0.1:${port}" + path, { method: "POST", body: JSON.stringify(body) }).then((response) => response.text());
if (args[0] === "session" && args[1] === "list") say({ success: true, data: { sessions: [process.env.AGENT_BROWSER_SESSION] } });
else if (args[0] === "close" || args[0] === "set") process.exit(0);
else if (args[0] === "mcp") {
  const tool = (name) => ({ name, description: name, inputSchema: { type: "object", properties: { script: { type: "string" } } } });
  const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "initialize") answer(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
    else if (message.method === "tools/list") answer(message.id, { tools: [tool("agent_browser_get_url"), tool("agent_browser_eval")] });
    else bridge("/mcp", message.params).then((text) => answer(message.id, JSON.parse(text)));
  });
}
else bridge("/engine", { args, proxy: process.env.AGENT_BROWSER_PROXY }).then((text) => { process.stdout.write(text); process.exit(0); }, () => process.exit(1));
`, { mode: 0o755 });

  const fixture = await launchVerificationServer(cuaRecord ? { OMB_TEST_DESKTOP_CUA_CONNECTION: cuaRecord } : {}, undefined, undefined, { binaryPath, executablePath: join(tools, "chrome") }, undefined, { scripted: true });
  const base = fixture.info.url;
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json", origin: base },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  const answered = (turn: number, tool: string) => evidence()[turn].evidence.filter((entry: any) => entry.step?.tool === tool).map((entry: any) => entry.response.result);
  return {
    page, base, planPath, engineArgs, proxies, fixture, evidence, api, answered,
    close: async () => {
      page.close();
      await fixture.close();
      await new Promise((done) => bridge.close(done));
      await removeTempDir(tools);
    },
  };
}

it.skipIf(process.platform === "win32")("saves a login from the sign-in card with the Microsoft sign-in page it shows, and fill_login signs in there in one call without the bot ever seeing the password", async () => {
  const browser = await browserFixture("https://login.microsoftonline.com/common/oauth2/authorize?client_id=fake");
  const { page, api, evidence, answered } = browser;
  page.answer = () => ({ navigate: INVOICES });
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Signer" })).body.bot;
    // A temporary browser: nothing of the stand-in's is saved or restored.
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);
    writeFileSync(browser.planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "request_sign_in", arguments: { site: "https://example.com/invoices", reason: "The invoices are behind a login." } }],
        reply: "I asked you to sign in to example.com." },
      // A careless bot repeats the password in its reply; the transcript must not keep it.
      { steps: [{ tool: "fill_login", arguments: {} }], reply: `Signed in. The password was ${PASSWORD}.` },
    ] } }));

    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Download this month's invoices.", "--url", browser.base]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    await expect.poll(async () => (await messages()).some((message) => message.kind === "signin"), { timeout: 15_000 }).toBe(true);
    const card = (await messages()).find((message) => message.kind === "signin");

    const target = await api("GET", `/api/bots/${bot.id}/sign-in-cards/${card.id}/save-login?threadId=${bot.threadId}`);
    expect(target).toMatchObject({ status: 200, body: { site: "example.com", signInHost: "login.microsoftonline.com" } });
    const saved = await api("POST", `/api/bots/${bot.id}/sign-in-cards/${card.id}/save-login`,
      { threadId: bot.threadId, username: USERNAME, password: PASSWORD, signInHost: "login.microsoftonline.com" });
    expect(saved).toMatchObject({ status: 200, body: { done: true, resumed: true, saved: true, site: "example.com and login.microsoftonline.com" } });
    expect(saved.text).not.toContain(PASSWORD);

    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(2);
    const resumed = evidence()[1];
    expect(JSON.stringify(resumed.prompt)).toContain("the person saved a login for example.com and login.microsoftonline.com. Open its login page in your browser and call fill_login there: it fills the form and submits it.");
    expect(resumed.system).toContain(`Your saved logins, for fill_login on these sites and their sign-in pages: example.com (${USERNAME}).`);
    const [filled] = answered(1, "fill_login");
    expect(filled.isError).toBeFalsy();
    expect(filled.content[0].text).toBe(`Filled the username and the password for ${USERNAME} on login.microsoftonline.com and submitted it; the page is now https://example.com/invoices (“Invoices”). Check you are signed in.`);
    expect(page.sent).toEqual([{ email: USERNAME, password: PASSWORD, csrf: "token-not-a-secret" }]);
    expect(page.pressed).toEqual(["Enter"]);
    expect([...browser.proxies]).toEqual([expect.stringMatching(/^socks5:\/\/127\.0\.0\.1:[1-9]\d*$/u)]);

    const logins = await api("GET", "/api/logins");
    expect(logins.body.logins).toEqual([expect.objectContaining({ site: "example.com", hosts: ["example.com", "login.microsoftonline.com"], exactHost: false, source: "card", bots: [bot.id] })]);
    await expect.poll(async () => (await messages()).some((message) => message.role === "bot" && String(message.text).startsWith("Signed in.")), { timeout: 15_000 }).toBe(true);
    const reply = (await messages()).find((message) => message.role === "bot" && String(message.text).startsWith("Signed in."));
    expect(reply.text).toBe("Signed in. The password was ••••••.");
    expect(JSON.stringify(evidence())).not.toContain(PASSWORD);
    expect(JSON.stringify(browser.engineArgs)).not.toContain(PASSWORD);
    expect(JSON.stringify(await messages())).not.toContain(PASSWORD);
    expect(logins.text).not.toContain(PASSWORD);
    expect(readFileSync(join(browser.fixture.info.dataDir, "logins.json.enc")).includes(Buffer.from(PASSWORD))).toBe(false);
  } finally {
    await browser.close();
  }
}, 120_000);

it.skipIf(process.platform === "win32")("fills a login saved for example.com on its subdomains, refuses eval on that page right after, offers no github.io login to another github.io name, and clears a refused login", async () => {
  const browser = await browserFixture("https://accounts.example.com/login");
  const { page, api, evidence, answered } = browser;
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Filler" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);
    expect((await api("POST", "/api/logins", { site: "example.com", username: USERNAME, password: PASSWORD })).status).toBe(201);
    expect((await api("POST", "/api/logins", { site: "alice.github.io", username: "alice", password: "fake-pages-pass" })).status).toBe(201);
    const readPassword = { server: "browser", tool: "agent_browser_eval", arguments: { script: "document.querySelector('#password').value" } };
    writeFileSync(browser.planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "fill_login", arguments: { submit: false } }, { ...readPassword, expectError: true }], reply: "Filled, not sent." },
      { steps: [{ tool: "fill_login", arguments: {}, expectError: true }], reply: "No login here." },
      { steps: [{ tool: "fill_login", arguments: {}, expectError: true }], reply: "The site refused it." },
    ] } }));
    const turn = async (text: string, count: number) => {
      await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", browser.base]);
      await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(count);
      expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20", "--url", browser.base])).toMatchObject({ status: "settled" });
    };

    await turn("Sign in to example.com.", 1);
    expect(answered(0, "fill_login")[0].content[0].text).toBe(`Filled the username and the password for ${USERNAME} on accounts.example.com. Submit the form now (its sign-in button, or Enter). The password is cleared from the page in 60 seconds. You never see the password; do not read it back from the page.`);
    const [evaluated] = answered(0, "agent_browser_eval");
    expect(evaluated).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^A saved password was just filled on this page, so agent_browser_eval is refused here/u) }] });
    expect(page.field("#password").value).toBe(PASSWORD);
    expect(page.sent).toEqual([]);

    page.navigate("https://bob.github.io/login", LOGIN_FORM);
    await turn("Sign in to Bob's page.", 2);
    expect(answered(1, "fill_login")[0].content[0].text).toBe(`No saved login for bob.github.io. A login fills on its own site and the sign-in hosts saved with it, never on another site. Your saved logins: alice.github.io (alice), example.com (${USERNAME}). Open that site's login page, or call request_sign_in so the person signs in.`);
    expect(page.typed).toEqual([USERNAME, PASSWORD]);

    page.navigate("https://www.example.com/login", LOGIN_FORM);
    page.answer = () => ({ error: "Incorrect password." });
    await turn("Try www.", 3);
    expect(answered(2, "fill_login")[0].content[0].text).toBe(`The site did not accept the login for ${USERNAME} on www.example.com. It said: “Incorrect password.”. Check the saved login in Settings → Logins, or call request_sign_in. The password was cleared from the page.`);
    expect(page.sent).toHaveLength(1);
    expect(page.field("#password").value).toBe("");
    expect(JSON.stringify(evidence())).not.toContain(PASSWORD);
    expect(JSON.stringify(browser.engineArgs)).not.toContain(PASSWORD);
  } finally {
    await browser.close();
  }
}, 120_000);

// Auto mounts this computer only on macOS and Windows, and the stand-in browser is a shebang script.
it.runIf(process.platform === "darwin")("on Auto, signs in in the bot's own browser beside this computer, never on the person's screen", async () => {
  // What the desktop app hands its own server once computer control is ready; the driver itself never runs here.
  const record = join(mkdtempSync(join(tmpdir(), "omb-saved-login-cua-")), "cua-connection.json");
  writeFileSync(record, JSON.stringify({
    mode: "embedded", status: "ready", socketPath: join(dirname(record), "cua.sock"), mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
  }), { mode: 0o600 });
  const browser = await browserFixture("https://example.com/login", record);
  const { page, api, evidence, answered } = browser;
  page.answer = () => ({ navigate: INVOICES });
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Statements" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { browserProfile: "guest" })).status).toBe(200);
    expect((await api("POST", "/api/logins", { site: "example.com", username: USERNAME, password: PASSWORD, bots: [bot.id] })).status).toBe(201);
    writeFileSync(browser.planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "fill_login", arguments: {} }], reply: "Signed in." },
    ] } }));

    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Sign in to example.com and get the invoices.", "--url", browser.base]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    const [turn] = evidence();
    expect(turn.system).toContain("Two surfaces are mounted");
    expect(turn.system).toContain("Web tasks → the built-in browser");
    expect(turn.system).toContain("use, in this order: your built-in browser, a cloud computer if select_computer offers one, a connected app");
    const [filled] = answered(0, "fill_login");
    expect(filled.isError).toBeFalsy();
    expect(filled.content[0].text).toBe(`Filled the username and the password for ${USERNAME} on example.com and submitted it; the page is now https://example.com/invoices (“Invoices”). Check you are signed in.`);
    expect(page.sent).toEqual([{ email: USERNAME, password: PASSWORD, csrf: "token-not-a-secret" }]);
    // The person's own screen was never touched, so nothing asked to use it.
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
    expect(messages.some((message) => message.card?.tool === "use_your_computer")).toBe(false);
    expect(JSON.stringify(evidence())).not.toContain(PASSWORD);
    expect(JSON.stringify(browser.engineArgs)).not.toContain(PASSWORD);
  } finally {
    await browser.close();
    await removeTempDir(dirname(record));
  }
}, 120_000);
