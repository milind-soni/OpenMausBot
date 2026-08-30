// The browser proxy end to end: spawn it the way a driver's mcpServers entry
// does, point it at a stub of the Electron browser host, and read what a
// model would read.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { browserHostTimeoutMs, classifyWall, formatObserved } from "./browser-proxy.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "browser-proxy.ts");
const TOKEN = "b".repeat(64);
const CONTROL_TOKEN = "control-token";

let stub: Server;
let stubPort = 0;
let held = false;
let helpOpen = false;
const helpRequests: Array<{ method: string; body: Record<string, unknown> }> = [];
const hits: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });
const text = (res: any) => String(res.result.content[0].text);

const PAGE = {
  url: "https://shop.example/cart?session=secret#frag",
  title: "Cart",
  elements: [
    { ref: "b1", role: "link", name: "Home" },
    { ref: "b2", role: "textbox", name: "Search", value: "shoes" },
  ],
};

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      if (path === "/control") {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "POST") {
          helpRequests.push({ method: "POST", body: raw ? JSON.parse(raw) : {} });
          helpOpen = true;
          return res.end(JSON.stringify({ requestId: "help-1" }));
        }
        if (req.method === "DELETE") {
          helpRequests.push({ method: "DELETE", body: raw ? JSON.parse(raw) : {} });
          helpOpen = false;
          return res.end(JSON.stringify({ ok: true }));
        }
        return res.end(JSON.stringify({ held, helpOpen }));
      }
      const body = raw ? JSON.parse(raw) : {};
      hits.push({ path, auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      res.setHeader("content-type", "application/json");
      if (path.endsWith("/click") && body.ref === "b99") {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: "that browser ref is stale or unknown — take a new browser_snapshot" }));
      }
      if (path.endsWith("/state")) return res.end(JSON.stringify({ url: PAGE.url, title: PAGE.title, loading: true }));
      if (path.endsWith("/read")) return res.end(JSON.stringify({ url: PAGE.url, title: PAGE.title, text: "Cart\n\n2 items · $80", truncated: false }));
      if (path.endsWith("/wait")) return res.end(JSON.stringify({ ...PAGE, notes: ["More of the page is off-screen: 900px below (browser_scroll to see it)."] }));
      if (path.endsWith("/screenshot")) return res.end(JSON.stringify({ png: "ZmFrZQ==", format: "jpeg" }));
      res.end(JSON.stringify(PAGE));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubPort = (stub.address() as { port: number }).port;
  child = spawn(process.execPath, ["--experimental-strip-types", PROXY], {
    env: {
      ...process.env,
      OMB_BROWSER_URL: `http://127.0.0.1:${stubPort}`,
      OMB_BROWSER_TOKEN: TOKEN,
      OMB_BOT_ID: "bot-1",
      OMB_BROWSER_PROFILE: "work",
      OMB_CONTROL_URL: `http://127.0.0.1:${stubPort}/control`,
      OMB_CONTROL_TOKEN: CONTROL_TOKEN,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  await rpc("initialize", { protocolVersion: "2024-11-05" });
});

afterAll(async () => {
  child.kill();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe("browser MCP proxy", () => {
  it("advertises the browser tool surface", async () => {
    const list = await rpc("tools/list");
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_fill",
      "browser_type",
      "browser_press",
      "browser_scroll",
      "browser_hover",
      "browser_drag",
      "browser_select_option",
      "browser_wait_for",
      "browser_read",
      "browser_back",
      "browser_forward",
      "browser_request_takeover",
      "browser_state",
      "browser_screenshot",
    ]);
  });

  it("forwards navigation to the bot's own tab and returns the page with a scrubbed address", async () => {
    hits.length = 0;
    const res = await callTool("browser_navigate", { url: "shop.example/cart" });
    // every call pins the profile the bot was mounted with
    expect(hits).toEqual([{ path: "/v1/bots/bot-1/navigate", auth: `Bearer ${TOKEN}`, body: { url: "shop.example/cart", profile: "work" } }]);
    expect(text(res)).toBe('Browser — Cart: https://shop.example/cart\nb1 link "Home"\nb2 textbox "Search" (value="shoes")');
    expect(res.result.isError).toBeFalsy();
  });

  it("acts on refs and relays the host's own sentence when one is stale", async () => {
    hits.length = 0;
    await callTool("browser_click", { ref: "b1", double: true });
    await callTool("browser_fill", { ref: "b2", text: "boots" });
    await callTool("browser_press", { key: "enter" });
    await callTool("browser_scroll", { direction: "down", amount: 300 });
    expect(hits.map((hit) => [hit.path, hit.body])).toEqual([
      ["/v1/bots/bot-1/click", { ref: "b1", double: true, profile: "work" }],
      ["/v1/bots/bot-1/fill", { ref: "b2", text: "boots", profile: "work" }],
      ["/v1/bots/bot-1/press", { key: "enter", profile: "work" }],
      ["/v1/bots/bot-1/scroll", { direction: "down", amount: 300, profile: "work" }],
    ]);
    const stale = await callTool("browser_click", { ref: "b99" });
    expect(stale.result.isError).toBe(true);
    expect(text(stale)).toMatch(/stale or unknown/);
    const missing = await callTool("browser_click", {});
    expect(missing.result.isError).toBe(true);
  });

  it("forwards the parity actions and relays the surface's notes", async () => {
    hits.length = 0;
    await callTool("browser_hover", { ref: "b1" });
    await callTool("browser_drag", { from: "b1", to: "b2" });
    await callTool("browser_select_option", { ref: "b2", values: "India" });
    await callTool("browser_select_option", { ref: "b2", values: ["a", "b"] });
    await callTool("browser_forward", {});
    const waited = await callTool("browser_wait_for", { text: "Cart", timeout_ms: 2000 });
    expect(hits.map((hit) => [hit.path.replace("/v1/bots/bot-1/", ""), hit.body])).toEqual([
      ["hover", { ref: "b1", profile: "work" }],
      ["drag", { from: "b1", to: "b2", profile: "work" }],
      ["select", { ref: "b2", values: ["India"], profile: "work" }],
      ["select", { ref: "b2", values: ["a", "b"], profile: "work" }],
      ["forward", { profile: "work" }],
      ["wait", { text: "Cart", timeoutMs: 2000, profile: "work" }],
    ]);
    expect(text(waited)).toContain("More of the page is off-screen: 900px below");
    const read = await callTool("browser_read", {});
    expect(text(read)).toBe("Cart: https://shop.example/cart\n\nCart\n\n2 items · $80");
    const bad = await callTool("browser_select_option", { ref: "b2" });
    expect(bad.result.isError).toBe(true);
    const emptyWait = await callTool("browser_wait_for", {});
    expect(emptyWait.result.isError).toBe(true);
    expect(text(emptyWait)).toMatch(/text or url is required/i);
  });

  it("reads state and screenshots without touching the page", async () => {
    const state = await callTool("browser_state", {});
    expect(text(state)).toBe("Cart: https://shop.example/cart (still loading)");
    const shot = await callTool("browser_screenshot", {});
    expect(shot.result.content[1]).toEqual({ type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg" });
  });

  it("refuses both actions and observations while the person holds the wheel", async () => {
    held = true;
    hits.length = 0;
    const refused = await callTool("browser_click", { ref: "b1" });
    expect(refused.result.isError).toBe(true);
    expect(text(refused)).toMatch(/wheel|control|driving/i);
    for (const tool of ["browser_snapshot", "browser_read", "browser_screenshot", "browser_state"]) {
      const privateResult = await callTool(tool, {});
      expect(privateResult.result.isError).toBe(true);
      expect(text(privateResult)).toMatch(/private information|taken control/i);
    }
    expect(hits).toEqual([]);
    held = false;
  });
});

describe("browser takeover", () => {
  it("pages the user, waits for the hand-back, and returns the page as it is afterwards", async () => {
    held = false;
    helpOpen = false;
    helpRequests.length = 0;
    const pending = callTool("browser_request_takeover", { reason: "Please sign in to GitHub" });
    // the person takes the wheel, then hands it back — the plea is closed by the app
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(helpRequests[0]).toEqual({ method: "POST", body: { reason: "Please sign in to GitHub" } });
    held = true;
    await new Promise((resolve) => setTimeout(resolve, 1700));
    held = false;
    helpOpen = false;
    const res = await pending;
    expect(res.result.isError).toBeFalsy();
    expect(text(res)).toMatch(/handed control back/);
    expect(text(res)).toContain('b1 link "Home"');
    const missing = await callTool("browser_request_takeover", {});
    expect(missing.result.isError).toBe(true);
  }, 20_000);
});

describe("classifyWall", () => {
  it("recognises sign-in and verification pages without flagging ordinary ones", () => {
    expect(classifyWall({ url: "https://github.com/login", title: "Sign in to GitHub", yaml: '- textbox "Password" [ref=e3]' })).toBe("sign-in");
    expect(classifyWall({ url: "https://accounts.google.com/v3/signin/identifier", title: "Google", yaml: "" })).toBe("sign-in");
    expect(classifyWall({ url: "https://shop.example/account", title: "Account", yaml: '- textbox "One-time code" [ref=e2]' })).toBe("sign-in");
    expect(classifyWall({ url: "https://shop.example/", title: "Just a moment...", yaml: "" })).toBe("verification");
    expect(classifyWall({ url: "https://shop.example/", title: "Shop", yaml: "- generic: Verify you are human" })).toBe("verification");
    expect(classifyWall({ url: "https://news.example/login-tips", title: "Ten login tips", yaml: '- link "Read more" [ref=e1]' })).toBeNull();
    expect(classifyWall({ url: "https://shop.example/cart", title: "Cart", elements: [{ ref: "b1", role: "button", name: "Checkout" }] })).toBeNull();
  });

  it("adds the takeover instruction to an observed wall page", () => {
    const rendered = formatObserved({ url: "https://github.com/login", title: "Sign in to GitHub", elements: [], yaml: '- textbox "Password" [ref=e3]' });
    expect(rendered).toContain("call browser_request_takeover");
    expect(rendered).toContain("Never type the user's password");
  });
});

describe("formatObserved", () => {
  it("prefers the Playwright-style snapshot when the surface has one", () => {
    expect(
      formatObserved({ url: "https://a.example/p?token=1", title: "T", elements: [], yaml: '- link "Docs" [ref=e1]', notes: ["900px below"] }),
    ).toBe('Browser — T: https://a.example/p\n- link "Docs" [ref=e1]\n900px below');
  });

  it("scrubs query and fragment and names an empty tab", () => {
    expect(formatObserved({ url: "https://a.example/p?token=1#x", title: "T", elements: [] })).toBe(
      "Browser — T: https://a.example/p\nNo interactive elements found.",
    );
    expect(formatObserved({ url: "about:blank", title: "", elements: [] })).toContain("about:blank");
  });

  it("strips protected field values even when an older host sends them", () => {
    const fallback = formatObserved({
      url: "https://accounts.example/signin",
      title: "Sign in",
      elements: [{ ref: "b7", role: "textbox", name: "Password", value: "hunter2" }],
    });
    expect(fallback).toContain('b7 textbox "Password"');
    expect(fallback).not.toContain("hunter2");

    const yaml = formatObserved({
      url: "https://accounts.example/signin",
      title: "Sign in",
      elements: [],
      yaml: '- textbox "Password" [ref=e7]: hunter2\n- textbox "Email" [ref=e8]: ada@example.com',
    });
    expect(yaml).toContain('- textbox "Password" [ref=e7]');
    expect(yaml).not.toContain("hunter2");
    expect(yaml).toContain("ada@example.com");

    const apiKey = formatObserved({
      url: "https://developer.example/settings",
      title: "Developer settings",
      elements: [{ ref: "b9", role: "textbox", name: "API key", value: "sk_live_secret" }],
    });
    expect(apiKey).not.toContain("sk_live_secret");
    const bankAccount = formatObserved({
      url: "https://billing.example/settings",
      title: "Billing settings",
      elements: [],
      yaml: '- textbox "Bank account number" [ref=e10]: 000123456789',
    });
    expect(bankAccount).not.toContain("000123456789");
    for (const name of ["AWS_SECRET_ACCESS_KEY", "Private key", "Signing key", "Webhook secret", "Refresh token", "Seed phrase", "Security answer"]) {
      const rendered = formatObserved({
        url: "https://developer.example/settings",
        title: "Secrets",
        elements: [{ ref: "b11", role: "textbox", name, value: "must-not-leak" }],
      });
      expect(rendered).not.toContain("must-not-leak");
    }
  });

  it("keeps the transport alive beyond the advertised browser wait", () => {
    expect(browserHostTimeoutMs("wait", { timeoutMs: 30_000 })).toBe(35_000);
    expect(browserHostTimeoutMs("wait", { timeoutMs: 2_000 })).toBe(20_000);
    expect(browserHostTimeoutMs("wait")).toBe(20_000);
    expect(browserHostTimeoutMs("navigate")).toBe(30_000);
  });
});
