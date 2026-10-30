// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  config: null as null | { team?: { id: string; name: string } },
  servers: [] as Array<Record<string, unknown>>,
  sharedHeaders: {} as Record<string, Record<string, string>>,
  personalMcp: [] as string[],
  personalKeys: {} as Record<string, string>,
  test: { ok: true, tools: [{ name: "a" }, { name: "b" }], total: 12 } as Record<string, unknown>,
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config, bots: [] }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/lib/mcp-servers", () => ({ updateMcpServers: vi.fn() }));

import { McpServersPanel } from "./McpServersPanel";

const ID = "id-7f3a9c2e1b.access";
const SECRET = "secret-9d8e7f6a5b4c3d2e1f";
const GATEWAY = `claude mcp add --transport http my-mcp https://mcp.example.com/route \\
  --header "CF-Access-Client-Id: $CF_ID" \\
  --header "CF-Access-Client-Secret: $CF_SECRET"`;

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); });
const button = (label: string) => [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
const click = async (label: string) => { await act(async () => button(label)!.click()); await settle(); };
const type = async (selector: string, value: string) => {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};
const calls = (method: string, path?: string) => fixture.api.mock.calls
  .filter(([url, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === method && (!path || url === path))
  .map(([url, init]) => ({ url: url as string, body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined }));

beforeEach(async () => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = null;
  fixture.servers = [];
  fixture.sharedHeaders = {};
  fixture.personalMcp = [];
  fixture.personalKeys = {};
  fixture.test = { ok: true, tools: [{ name: "a" }, { name: "b" }], total: 12 };
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET" && path === "/api/mcp/servers") return { servers: fixture.servers };
    if (method === "GET" && path === "/api/team/my-connections") return { mcp: fixture.personalMcp.map((name) => ({ name })) };
    if (method === "POST" && path === "/api/mcp/servers") {
      fixture.sharedHeaders[body.name] = body.headers ?? {};
      fixture.servers = [...fixture.servers, { name: body.name, type: body.type, url: body.url, headerKeys: Object.keys(body.headers ?? {}), enabled: false }];
      return { servers: fixture.servers };
    }
    if (method === "POST" && path.endsWith("/test")) return fixture.test;
    if (method === "PATCH") {
      const name = decodeURIComponent(path.split("/").at(-1)!);
      fixture.servers = fixture.servers.map((server) => server.name === name ? { ...server, enabled: body.enabled } : server);
      return { servers: fixture.servers };
    }
    if (method === "PUT" && path.startsWith("/api/mcp/servers/")) {
      const name = decodeURIComponent(path.split("/").at(-1)!);
      fixture.sharedHeaders[name] = body.headers ?? {};
      fixture.servers = fixture.servers.map((server) => server.name === name ? { ...server, headerKeys: Object.keys(body.headers ?? {}), enabled: body.enabled } : server);
      return { servers: fixture.servers };
    }
    if (method === "PUT" && path === "/api/team/connection-scopes") {
      fixture.personalMcp = [body.id];
      return { scopes: { apps: [], mcp: fixture.personalMcp } };
    }
    if (method === "PUT" && path.startsWith("/api/team/my-connections/mcp/")) {
      fixture.personalKeys[decodeURIComponent(path.split("/").at(-2)!)] = body.value;
      return { ok: true };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(() => McpServersPanel())));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Adding an MCP server from one paste box", () => {
  it("reads a pasted claude mcp add command, asks only for the two variables, then saves, connects and turns it on", async () => {
    await click("Add server");
    expect(host.querySelector("[data-mcp-editor] input")).toBeNull();
    await type("textarea[aria-label='Server link or setup command']", GATEWAY);
    expect(host.textContent).toContain("Ready to add my-mcp (mcp.example.com).");
    expect(host.textContent).toContain("Paste the real value of CF_ID here: the command used a variable from your terminal.");
    expect(host.textContent).toContain("Paste the real value of CF_SECRET here: the command used a variable from your terminal.");
    expect([...host.querySelectorAll("[data-mcp-editor] input")].map((input) => [input.getAttribute("aria-label"), input.getAttribute("type")]))
      .toEqual([["CF-Access-Client-Id", "password"], ["CF-Access-Client-Secret", "password"]]);

    await click("Add");
    expect(host.querySelector("[data-mcp-editor] [role=alert]")?.textContent).toBe("Fill in CF-Access-Client-Id, or remove it.");
    expect(calls("POST", "/api/mcp/servers")).toEqual([]);

    await type("input[aria-label='CF-Access-Client-Id']", ID);
    await type("input[aria-label='CF-Access-Client-Secret']", SECRET);
    await click("Add");

    expect(calls("POST", "/api/mcp/servers")).toEqual([{ url: "/api/mcp/servers", body: {
      name: "my-mcp", type: "http", url: "https://mcp.example.com/route", headers: { "CF-Access-Client-Id": ID, "CF-Access-Client-Secret": SECRET },
    } }]);
    expect(calls("POST", "/api/mcp/servers/my-mcp/test")).toHaveLength(1);
    expect(calls("PATCH", "/api/mcp/servers/my-mcp")).toEqual([{ url: "/api/mcp/servers/my-mcp", body: { enabled: true } }]);
    expect(host.querySelector("[data-mcp-editor]")).toBeNull();
    expect(host.textContent).toContain("Connected: 12 tools");
    expect(host.querySelector('[role="switch"][aria-label="Turn my-mcp off"]')?.getAttribute("aria-checked")).toBe("true");
    expect(host.innerHTML).not.toContain(SECRET);
    expect(calls("PUT")).toEqual([]);
  });

  it("leaves a server it can't reach off, says why, and turns it on from Try again", async () => {
    fixture.test = { ok: false, error: "Could not reach this address. Check the URL and your network.", reason: "unreachable" };
    await click("Add server");
    await type("textarea[aria-label='Server link or setup command']", "https://mcp.acme.example/mcp");
    await click("Add");
    expect(calls("POST", "/api/mcp/servers")[0]?.body).toEqual({ name: "acme", type: "http", url: "https://mcp.acme.example/mcp", headers: {} });
    expect(calls("PATCH")).toEqual([]);
    expect(host.textContent).toContain("Couldn't connect, so it stays off. Could not reach this address. Check the URL and your network.");
    expect(button("Fix the keys")).toBeUndefined();

    fixture.test = { ok: true, tools: [{ name: "search" }] };
    await click("Try again");
    expect(calls("PATCH", "/api/mcp/servers/acme")).toEqual([{ url: "/api/mcp/servers/acme", body: { enabled: true } }]);
    expect(host.textContent).toContain("Connected: 1 tool");
  });

  it("says which keys a gateway refused, by name only, and Fix the keys asks for just those values and tests again", async () => {
    fixture.test = { ok: false, error: "The server didn't accept the keys (HTTP 403). Check the header values.", reason: "keys", status: 403 };
    await click("Add server");
    await type("textarea[aria-label='Server link or setup command']", GATEWAY);
    await type("input[aria-label='CF-Access-Client-Id']", ID);
    await type("input[aria-label='CF-Access-Client-Secret']", "wrong-secret-value");
    await click("Add");
    expect(host.textContent).toContain(
      "Couldn't connect, so it stays off. The server didn't accept the keys (HTTP 403). Check the values of CF-Access-Client-Id and CF-Access-Client-Secret.");
    expect(button("Try again")).toBeUndefined();
    expect(host.innerHTML).not.toContain("wrong-secret-value");
    expect(host.innerHTML).not.toContain(ID);

    await click("Fix the keys");
    const editor = host.querySelector("[data-mcp-editor]")!;
    expect(editor.textContent).toContain("Fix the keys for my-mcp");
    expect([...editor.querySelectorAll("input")].map((input) => [input.getAttribute("aria-label"), input.type, input.value, input.placeholder])).toEqual([
      ["CF-Access-Client-Id", "password", "", "Paste the new value"],
      ["CF-Access-Client-Secret", "password", "", "Paste the new value"],
    ]);
    expect(editor.querySelector("textarea")).toBeNull();

    fixture.test = { ok: true, tools: [{ name: "a" }], total: 12 };
    const previous = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "PUT" ? { servers: fixture.servers } : previous(path, init));
    await type("input[aria-label='CF-Access-Client-Secret']", SECRET);
    await click("Save");
    expect(calls("PUT", "/api/mcp/servers/my-mcp")[0]?.body).toEqual({
      type: "http", url: "https://mcp.example.com/route", headers: { "CF-Access-Client-Id": true, "CF-Access-Client-Secret": SECRET }, enabled: false,
    });
    expect(calls("POST", "/api/mcp/servers/my-mcp/test")).toHaveLength(2);
    expect(calls("PATCH", "/api/mcp/servers/my-mcp")).toEqual([{ url: "/api/mcp/servers/my-mcp", body: { enabled: true } }]);
    expect(host.textContent).toContain("Connected: 12 tools");
  });

  it("offers a key row to a server that refused without one, and no button for an error a retry can't fix", async () => {
    fixture.test = { ok: false, error: "The server didn't accept the keys (HTTP 401). Check the header values.", reason: "keys", status: 401 };
    await click("Add server");
    await type("textarea[aria-label='Server link or setup command']", "https://mcp.acme.example/mcp");
    await click("Add");
    expect(host.textContent).toContain("The server didn't let it in (HTTP 401). It probably needs a key: add it with Fix the keys.");
    await click("Fix the keys");
    expect([...host.querySelectorAll("[data-mcp-editor] input")].map((input) => input.getAttribute("aria-label"))).toEqual(["Header name", "Value"]);
    await click("Cancel");

    fixture.test = { ok: false, error: "The server did not return a valid MCP tools list." };
    await click("Test");
    expect(host.textContent).toContain("Couldn't connect, so it stays off. The server did not return a valid MCP tools list.");
    expect(button("Try again")).toBeUndefined();
    expect(button("Fix the keys")).toBeUndefined();
  });

  it("says plainly when the paste isn't a server, and keeps Add off", async () => {
    await click("Add server");
    await type("textarea[aria-label='Server link or setup command']", "please help me connect my server");
    expect(host.querySelector("[data-mcp-editor] [role=alert]")?.textContent).toBe(
      "That doesn't look like a server link or a setup command. Check you copied all of it, or fill it in yourself under Edit details.");
    expect(button("Add")?.disabled).toBe(true);
  });

  it("opens a saved server with its header names and no values, and keeps the saved ones on Save", async () => {
    fixture.servers = [{ name: "gate", type: "http", url: "https://mcp.example.com/route", headerKeys: ["CF-Access-Client-Id", "CF-Access-Client-Secret"], enabled: false }];
    fixture.api.mockImplementationOnce(async () => ({ servers: fixture.servers }));
    await act(async () => button("Add server")!.parentElement!.querySelector<HTMLButtonElement>("[aria-label='Refresh MCP servers']")!.click());
    await settle();
    const previous = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => init?.method === "PUT" ? { servers: fixture.servers } : previous(path, init));
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit gate']")!.click());
    await settle();
    const values = [...host.querySelectorAll<HTMLInputElement>("[data-mcp-editor] input[type=password]")];
    expect(values.map((input) => [input.getAttribute("aria-label"), input.value, input.placeholder])).toEqual([
      ["CF-Access-Client-Id", "", "Saved · leave blank to keep it"],
      ["CF-Access-Client-Secret", "", "Saved · leave blank to keep it"],
      [null, "", "Optional, for a confidential app"],
    ]);
    await type("input[aria-label='CF-Access-Client-Secret']", "rotated-secret");
    await click("Save");
    expect(calls("PUT", "/api/mcp/servers/gate")[0]?.body).toEqual({
      type: "http", url: "https://mcp.example.com/route", headers: { "CF-Access-Client-Id": true, "CF-Access-Client-Secret": "rotated-secret" }, enabled: false,
    });
    expect(calls("PATCH", "/api/mcp/servers/gate")).toEqual([{ url: "/api/mcp/servers/gate", body: { enabled: true } }]);
  });
});

describe("Adding an MCP server on a Team Cloud", () => {
  beforeEach(() => { fixture.config = { team: { id: "team-1", name: "Acme" } }; });

  it("says everyone on the team can use it, and offers Only for me only for a server with one key", async () => {
    await click("Add server");
    await type("textarea[aria-label='Server link or setup command']", GATEWAY.replace("$CF_ID", ID).replace("$CF_SECRET", SECRET));
    expect(host.querySelector("[data-mcp-team-scope]")?.textContent).toBe("Everyone on your team can use this.");
    expect(host.querySelector("[data-mcp-team-scope] input")).toBeNull();
    await click("Add");
    expect(calls("PUT")).toEqual([]);
  });

  it.each(["Authorization", "X-Api-Key"])("keeps %s as this person's own when it's Only for me", async (header) => {
    await click("Add server");
    await type("textarea[aria-label='Server link or setup command']", `claude mcp add --transport http mail https://mail.example.com/mcp -H "${header}: Bearer $MAIL_KEY"`);
    await type(`input[aria-label='${header}']`, "mail-key-12345");
    await act(async () => host.querySelector<HTMLInputElement>("[data-mcp-team-scope] input[type=checkbox]")!.click());
    await settle();
    expect(host.querySelector("[data-mcp-team-scope]")?.textContent).toContain("Only you can use this. Teammates can add their own key from their team page.");
    await click("Add");
    expect(calls("POST", "/api/mcp/servers")[0]?.body.headers).toEqual({ [header]: "" });
    expect(calls("PUT")).toEqual([
      { url: "/api/team/connection-scopes", body: { kind: "mcp", id: "mail", scope: "person" } },
      { url: "/api/team/my-connections/mcp/mail/key", body: { value: "Bearer mail-key-12345", url: "https://mail.example.com/mcp" } },
      { url: "/api/mcp/servers/mail", body: { type: "http", url: "https://mail.example.com/mcp", headers: { [header]: "" }, enabled: false } },
    ]);
    expect(fixture.sharedHeaders.mail).toEqual({ [header]: "" });
    expect(calls("POST", "/api/mcp/servers/mail/test")).toHaveLength(1);
    expect(fixture.servers).toEqual([expect.objectContaining({ name: "mail", enabled: true })]);
    expect(host.textContent).toContain(`Headers saved: ${header}`);
    expect(host.textContent).toContain("Connected: 12 tools");
    fixture.test = { ok: false, error: "Could not reach this address.", reason: "unreachable" };
    await click("Test");
    fixture.test = { ok: true, tools: [{ name: "a" }], total: 12 };
    await click("Try again");
    expect(calls("POST", "/api/mcp/servers/mail/test")).toHaveLength(3);
    expect(fixture.sharedHeaders.mail).toEqual({ [header]: "" });
    expect(host.textContent).toContain("Connected: 12 tools");
  });

  it.each([
    ["edit", "Authorization"], ["edit", "X-Api-Key"],
    ["fix", "Authorization"], ["fix", "X-Api-Key"],
  ])("keeps a replacement personal key private on %s with %s", async (action, header) => {
    await click("Add server");
    await type("textarea[aria-label='Server link or setup command']", `claude mcp add --transport http mail https://mail.example.com/mcp -H "${header}: Bearer $MAIL_KEY"`);
    await type(`input[aria-label='${header}']`, "mail-key-12345");
    await act(async () => host.querySelector<HTMLInputElement>("[data-mcp-team-scope] input[type=checkbox]")!.click());
    if (action === "fix") fixture.test = { ok: false, reason: "keys", status: 401 };
    await click("Add");
    fixture.api.mockClear();
    if (action === "fix") await click("Fix the keys");
    else await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit mail']")!.click());
    await type(`input[aria-label='${header}']`, "Bearer replacement-key-67890");
    fixture.test = { ok: true, tools: [{ name: "read_inbox" }] };
    await click("Save");

    expect(calls("PUT", "/api/mcp/servers/mail")[0]?.body.headers).toEqual({ [header]: "" });
    expect(calls("PUT", "/api/team/my-connections/mcp/mail/key")).toEqual([
      { url: "/api/team/my-connections/mcp/mail/key", body: { value: "Bearer replacement-key-67890", url: "https://mail.example.com/mcp" } },
    ]);
    expect(fixture.sharedHeaders.mail).toEqual({ [header]: "" });
    expect(fixture.personalKeys.mail).toBe("Bearer replacement-key-67890");
    const writes = fixture.api.mock.calls.map(([path]) => path);
    expect(writes.indexOf("/api/team/my-connections/mcp/mail/key")).toBeLessThan(writes.indexOf("/api/mcp/servers/mail/test"));
    expect(calls("POST", "/api/mcp/servers/mail/test")).toHaveLength(1);
    expect(host.textContent).toContain("Connected: 1 tool");
    expect(host.querySelector("[data-mcp-editor]")).toBeNull();
  });

  it.each(["edit", "fix"])("shows the URL conflict and keeps the editor open on %s", async (action) => {
    fixture.servers = [{ name: "mail", type: "http", url: "https://mail.example.com/mcp", headerKeys: ["Authorization"], enabled: true }];
    fixture.personalMcp = ["mail"];
    fixture.personalKeys.mail = "Bearer kept-key-12345";
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Refresh MCP servers']")!.click());
    await settle();
    if (action === "fix") {
      fixture.test = { ok: false, reason: "keys", status: 401 };
      await click("Test");
      await click("Fix the keys");
    } else {
      await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit mail']")!.click());
    }
    const previous = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/team/my-connections/mcp/mail/key") throw new Error("The MCP server address changed. Reload the server and try again.");
      return previous(path, init);
    });
    await type("input[aria-label='Authorization']", "Bearer replacement-key-67890");
    fixture.api.mockClear();
    await click("Save");

    expect(host.textContent).toContain("The MCP server address changed. Reload the server and try again.");
    expect(host.querySelector("[data-mcp-editor]")).not.toBeNull();
    expect(fixture.personalKeys.mail).toBe("Bearer kept-key-12345");
    expect(calls("POST")).toEqual([]);
  });

  it.each(["Authorization", "X-Api-Key"])("keeps an OAuth-to-key edit private with %s", async (header) => {
    fixture.servers = [{
      name: "mail", type: "http", url: "https://mail.example.com/mcp", headerKeys: [], enabled: true,
      oauth: { clientId: "fixture-client-id", scopes: [], clientSecretConfigured: false, redirectUri: "https://cloud.example.com/callback" },
    }];
    fixture.sharedHeaders.mail = {};
    fixture.personalMcp = ["mail"];
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Refresh MCP servers']")!.click());
    await settle();
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit mail']")!.click());
    await type("input[value='fixture-client-id']", "");
    await type("input[aria-label='Header name']", header);
    await type(`input[aria-label='${header}']`, "Bearer converted-personal-key");
    await click("Save");

    expect(calls("PUT", "/api/mcp/servers/mail")).toEqual([{
      url: "/api/mcp/servers/mail",
      body: { type: "http", url: "https://mail.example.com/mcp", headers: { [header]: "" }, enabled: true },
    }]);
    expect(fixture.sharedHeaders.mail).toEqual({ [header]: "" });
    expect(fixture.personalKeys.mail).toBe("Bearer converted-personal-key");
    expect(host.textContent).toContain("Connected: 12 tools");
    expect(host.querySelector("[data-mcp-editor]")).toBeNull();
  });

  it.each([
    ["edit", ""], ["fix", ""],
    ["edit", "Bearer replacement-key"], ["fix", "Bearer replacement-key"],
  ])("preserves a personal multi-header configuration on %s with first value '%s'", async (action, value) => {
    fixture.servers = [{ name: "mail", type: "http", url: "https://mail.example.com/mcp", headerKeys: ["Authorization", "X-Tenant"], enabled: true }];
    fixture.sharedHeaders.mail = { Authorization: "", "X-Tenant": "" };
    fixture.personalMcp = ["mail"];
    fixture.personalKeys.mail = "Bearer kept-key-12345";
    const original = structuredClone(fixture.servers);
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Refresh MCP servers']")!.click());
    await settle();
    if (action === "fix") {
      fixture.test = { ok: false, reason: "keys", status: 401 };
      await click("Test");
      await click("Fix the keys");
    } else {
      await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit mail']")!.click());
    }
    if (value) await type("input[aria-label='Authorization']", value);
    await type("input[aria-label='X-Tenant']", "new-tenant");
    fixture.api.mockClear();
    await click("Save");

    expect(calls("PUT")).toEqual([]);
    expect(calls("POST")).toEqual([]);
    expect(fixture.servers).toEqual(original);
    expect(fixture.sharedHeaders.mail).toEqual({ Authorization: "", "X-Tenant": "" });
    expect(fixture.personalKeys.mail).toBe("Bearer kept-key-12345");
    expect(host.textContent).toContain("Personal MCP connections support one header. Remove the extra headers before saving.");
    expect(host.querySelector("[data-mcp-editor]")).not.toBeNull();
  });

  it("keeps a saved personal key when an edit leaves its value blank", async () => {
    fixture.servers = [{ name: "mail", type: "http", url: "https://mail.example.com/mcp", headerKeys: ["Authorization"], enabled: true }];
    fixture.sharedHeaders.mail = { Authorization: "" };
    fixture.personalMcp = ["mail"];
    fixture.personalKeys.mail = "Bearer kept-key-12345";
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Refresh MCP servers']")!.click());
    await settle();
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit mail']")!.click());
    await click("Save");

    expect(calls("PUT", "/api/mcp/servers/mail")[0]?.body.headers).toEqual({ Authorization: "" });
    expect(calls("PUT", "/api/team/my-connections/mcp/mail/key")).toEqual([]);
    expect(fixture.personalKeys.mail).toBe("Bearer kept-key-12345");
  });

  it("still writes replacement team keys to shared headers", async () => {
    await click("Add server");
    await type("textarea[aria-label='Server link or setup command']", 'claude mcp add --transport http mail https://mail.example.com/mcp -H "Authorization: Bearer $MAIL_KEY"');
    await type("input[aria-label='Authorization']", "team-key-12345");
    await click("Add");
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit mail']")!.click());
    await type("input[aria-label='Authorization']", "Bearer replacement-team-key");
    await click("Save");

    expect(calls("PUT", "/api/mcp/servers/mail")[0]?.body.headers).toEqual({ Authorization: "Bearer replacement-team-key" });
    expect(fixture.sharedHeaders.mail).toEqual({ Authorization: "Bearer replacement-team-key" });
    expect(calls("PUT", "/api/team/my-connections/mcp/mail/key")).toEqual([]);
  });

  it.each([
    ["edit", "403 Forbidden"], ["fix", "403 Forbidden"],
    ["edit", "Network request failed"], ["fix", "Network request failed"],
  ])("saves a known team key on %s without a personal lookup that would fail with %s", async (action, failure) => {
    fixture.servers = [{ name: "mail", type: "http", url: "https://mail.example.com/mcp", headerKeys: ["Authorization"], enabled: true, scope: "team" }];
    fixture.sharedHeaders.mail = { Authorization: "Bearer team-key-12345" };
    await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Refresh MCP servers']")!.click());
    await settle();
    const previous = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/team/my-connections") throw new Error(failure);
      return previous(path, init);
    });
    if (action === "fix") {
      fixture.test = { ok: false, reason: "keys", status: 401 };
      await click("Test");
      await click("Fix the keys");
    } else {
      await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit mail']")!.click());
    }
    await type("input[aria-label='Authorization']", "Bearer replacement-team-key");
    fixture.test = { ok: true, tools: [{ name: "read_inbox" }] };
    await click("Save");

    expect(fixture.sharedHeaders.mail).toEqual({ Authorization: "Bearer replacement-team-key" });
    expect(calls("GET", "/api/team/my-connections")).toEqual([]);
    expect(calls("PUT", "/api/team/my-connections/mcp/mail/key")).toEqual([]);
    expect(host.querySelector("[data-mcp-editor]")).toBeNull();
    expect(host.textContent).toContain("Connected: 1 tool");
  });

  it.each([
    [undefined, "/api/team/my-connections"], ["person", "/api/team/my-connections"],
    [undefined, "/api/team/my-connections/mcp/mail/key"], ["person", "/api/team/my-connections/mcp/mail/key"],
  ])(
    "does not share a replacement key or test the connection with scope %s when %s fails", async (scope, failedPath) => {
      fixture.servers = [{ name: "mail", type: "http", url: "https://mail.example.com/mcp", headerKeys: ["Authorization"], enabled: true, scope }];
      fixture.sharedHeaders.mail = { Authorization: "" };
      fixture.personalMcp = ["mail"];
      fixture.personalKeys.mail = "Bearer kept-key-12345";
      await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Refresh MCP servers']")!.click());
      await settle();
      const previous = fixture.api.getMockImplementation()!;
      fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path === failedPath) throw new Error("Personal connection unavailable.");
        return previous(path, init);
      });
      await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit mail']")!.click());
      await type("input[aria-label='Authorization']", "Bearer replacement-key-67890");
      await click("Save");

      expect(fixture.sharedHeaders.mail).toEqual({ Authorization: "" });
      expect(fixture.personalKeys.mail).toBe("Bearer kept-key-12345");
      expect(calls("PUT", "/api/mcp/servers/mail").every(({ body }) => body.headers.Authorization === "")).toBe(true);
      expect(calls("POST", "/api/mcp/servers/mail/test")).toEqual([]);
      expect(host.textContent).toContain("Personal connection unavailable.");
      expect(host.querySelector("[data-mcp-editor]")).not.toBeNull();
    },
  );

  it.each(["/api/team/connection-scopes", "/api/team/my-connections/mcp/mail/key"])(
    "keeps Only for me disabled and never saves the shared key when %s fails", async (failedPath) => {
      const previous = fixture.api.getMockImplementation()!;
      fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
        if (init?.method === "PUT" && path === failedPath) throw new Error("Personal setup failed.");
        return previous(path, init);
      });
      await click("Add server");
      await type("textarea[aria-label='Server link or setup command']", 'claude mcp add --transport http mail https://mail.example.com/mcp -H "Authorization: Bearer $MAIL_KEY"');
      await type("input[aria-label='Authorization']", "mail-key-12345");
      await act(async () => host.querySelector<HTMLInputElement>("[data-mcp-team-scope] input[type=checkbox]")!.click());
      await settle();
      await click("Add");

      expect(fixture.servers).toEqual([expect.objectContaining({ name: "mail", enabled: false })]);
      expect(fixture.sharedHeaders.mail).toEqual({ Authorization: "" });
      expect(calls("POST", "/api/mcp/servers/mail/test")).toEqual([]);
      expect(calls("PATCH")).toEqual([]);
      expect(host.textContent).toContain("Personal setup failed.");
      expect(host.textContent).not.toContain("Connected:");
    },
  );

  it.each(["/api/team/connection-scopes", "/api/team/my-connections/mcp/mail/key"])(
    "never shares the personal key after %s fails, even if server updates fail and the row is later enabled", async (failedPath) => {
      const previous = fixture.api.getMockImplementation()!;
      fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
        if (init?.method === "PUT" && path === failedPath) throw new Error("Personal setup failed.");
        if (init?.method === "PUT" && path.startsWith("/api/mcp/servers/")) throw new Error("Server update failed.");
        return previous(path, init);
      });
      await click("Add server");
      await type("textarea[aria-label='Server link or setup command']", 'claude mcp add --transport http mail https://mail.example.com/mcp -H "Authorization: Bearer $MAIL_KEY"');
      await type("input[aria-label='Authorization']", "mail-key-12345");
      await act(async () => host.querySelector<HTMLInputElement>("[data-mcp-team-scope] input[type=checkbox]")!.click());
      await settle();
      await click("Add");

      expect.soft(host.textContent).toContain("Personal setup failed.");
      expect.soft(fixture.servers).toEqual([expect.objectContaining({ name: "mail", enabled: false })]);
      expect.soft(calls("POST", "/api/mcp/servers/mail/test")).toEqual([]);
      expect.soft(calls("PATCH")).toEqual([]);
      await click("Cancel");
      await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Refresh MCP servers']")!.click());
      await settle();
      await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Turn mail on"]')!.click());
      await settle();

      expect(fixture.servers).toEqual([expect.objectContaining({ name: "mail", enabled: true })]);
      expect(fixture.sharedHeaders.mail).toEqual({ Authorization: "" });
    },
  );
});
