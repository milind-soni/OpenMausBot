import { describe, expect, it } from "vitest";

import { botListing, botMayChange, mcpOwner, mergeBotUpdate } from "./mcp-bot-rules.ts";
import { parseMcpServerMutation, type StoredMcpServer, type StoredRemoteMcpServer, type StoredStdioMcpServer } from "./mcp-registry.ts";

const REF = `secret-ref:${"a".repeat(32)}`;

const stdio = (extra: Partial<StoredStdioMcpServer> = {}): StoredStdioMcpServer => ({
  command: "npx", args: ["-y", "dodo-mcp"], env: { DODO_PAYMENTS_API_KEY: "sk-live-123", API_KEY: "k1" }, enabled: true, ...extra,
});
const remote = (extra: Partial<StoredRemoteMcpServer> = {}): StoredRemoteMcpServer => ({
  type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" }, enabled: true,
  oauth: { clientId: "cid", clientSecret: "shh" }, ...extra,
});

describe("mcpOwner and botMayChange", () => {
  const owner = (server: StoredMcpServer, personal: string[] = []) => mcpOwner("x", server, "bot1", personal);

  it("shared servers belong to everyone and may change", () => {
    expect(owner(stdio())).toBe("shared");
    expect(botMayChange("shared")).toEqual({ ok: true });
  });
  it("a bot's own server may change", () => {
    expect(owner(stdio({ bot: "bot1" }))).toBe("own");
    expect(botMayChange("own")).toEqual({ ok: true });
  });
  it("another bot's server is refused", () => {
    expect(owner(stdio({ bot: "bot2" }))).toBe("theirs");
    expect(botMayChange("theirs")).toEqual({ ok: false, error: "That server belongs to another bot." });
  });
  it("a Team Cloud personal server wins over everything else", () => {
    expect(owner(remote(), ["x"])).toBe("person");
    expect(owner(stdio({ bot: "bot2" }), ["x"])).toBe("person");
    expect(botMayChange("person")).toEqual({ ok: false, error: "This connection is each person's own. Change it in Settings." });
  });
  it("a bot's own server that runs elsewhere is elsewhere", () => {
    expect(owner(stdio({ bot: "bot1", runsOn: { environmentId: "e1", label: "Mac" } }))).toBe("elsewhere");
    expect(owner(stdio({ bot: "bot2", runsOn: { environmentId: "e1", label: "Mac" } }))).toBe("theirs");
  });
  it("a server that runs elsewhere names the computer", () => {
    const server = stdio({ runsOn: { environmentId: "e1", label: "Studio Mac" } });
    expect(owner(server)).toBe("elsewhere");
    expect(botMayChange("elsewhere", server)).toEqual({ ok: false, error: "This server runs on Studio Mac, so it can't be changed here." });
  });
});

describe("mergeBotUpdate", () => {
  it("keeps an unsent env key as true when only env changes", () => {
    const { body, dropped } = mergeBotUpdate(stdio(), { env: { EXTRA: REF } });
    expect(body.env).toEqual({ DODO_PAYMENTS_API_KEY: true, API_KEY: true, EXTRA: REF });
    expect(dropped).toEqual([]);
  });

  it("drops saved env and header values when args change", () => {
    const { body, dropped } = mergeBotUpdate(stdio({ env: { DODO_PAYMENTS_API_KEY: "sk" } }), { args: ["-y", "other"] });
    expect(body.env).toBeUndefined();
    expect(dropped).toEqual(["env DODO_PAYMENTS_API_KEY"]);
  });

  it("keeps a key resupplied as a secretRef when the url changes", () => {
    const { body, dropped } = mergeBotUpdate(remote(), { url: "https://evil.example.com/mcp", headers: { Authorization: `Bearer ${REF}` } });
    expect(body.headers).toEqual({ Authorization: `Bearer ${REF}` });
    expect(dropped).toEqual(["oauth client secret", "sign-in"]);
  });

  it("does not list a header the patch replaces with a literal", () => {
    const { dropped } = mergeBotUpdate(remote(), { url: "https://evil.example.com/mcp", headers: { Authorization: "Bearer attacker" } });
    expect(dropped).not.toContain("header Authorization");
  });

  it("drops saved keys when a value only embeds a secretRef", () => {
    const { dropped } = mergeBotUpdate(stdio(), { env: { BASE_URL: `https://evil/?k=${REF}` } });
    expect(dropped).toEqual(["env DODO_PAYMENTS_API_KEY", "env API_KEY"]);
  });

  it("counts the {secretRef} object form as a secretRef", () => {
    const { dropped } = mergeBotUpdate(stdio(), { env: { API_KEY: { secretRef: REF } } });
    expect(dropped).toEqual([]);
  });

  it("treats a literal equal to the saved value as a destination change", () => {
    const { dropped } = mergeBotUpdate(stdio(), { env: { API_KEY: "k1" } });
    expect(dropped).toEqual(["env DODO_PAYMENTS_API_KEY"]);
  });

  it("treats a command change as a destination change", () => {
    const { dropped } = mergeBotUpdate(stdio(), { command: "node" });
    expect(dropped).toEqual(["env DODO_PAYMENTS_API_KEY", "env API_KEY"]);
  });

  it("drops sign-in when the url changes", () => {
    const { body, dropped } = mergeBotUpdate(remote(), { url: "https://other.example.com/mcp" });
    expect(dropped).toEqual(["header Authorization", "oauth client secret", "sign-in"]);
    expect(body.oauth).toEqual({ clientId: "cid" });
  });

  it("keeps saved headers, oauth secret and sign-in when the url is unchanged", () => {
    const { body, dropped } = mergeBotUpdate(remote(), { url: "https://mcp.example.com/mcp", resultBudget: 100 });
    expect(body.headers).toEqual({ Authorization: true });
    expect(body.oauth).toEqual({ clientId: "cid", clientSecret: true });
    expect(dropped).toEqual([]);
  });

  it("treats a literal env change on a command server as a destination change", () => {
    const { body, dropped } = mergeBotUpdate(stdio(), { env: { NODE_OPTIONS: "--require /tmp/x.js" } });
    expect(dropped).toEqual(["env DODO_PAYMENTS_API_KEY", "env API_KEY"]);
    expect(body.env).toEqual({ NODE_OPTIONS: "--require /tmp/x.js" });
  });

  it("keeps other saved keys when the only change is a fresh secretRef", () => {
    const { body, dropped } = mergeBotUpdate(stdio(), { env: { API_KEY: REF } });
    expect(body.env).toEqual({ DODO_PAYMENTS_API_KEY: true, API_KEY: REF });
    expect(dropped).toEqual([]);
  });

  it("produces a body parseMcpServerMutation accepts", () => {
    for (const [existing, patch] of [
      [stdio(), { env: { API_KEY: "plain" } }],
      [remote(), { url: "https://mcp.example.com/mcp", oauth: { clientId: "cid" } }],
    ] as const) {
      const { body } = mergeBotUpdate(existing, patch);
      expect(parseMcpServerMutation("x", body, existing).ok).toBe(true);
    }
  });
});

describe("botListing", () => {
  const extra = { owner: "shared", authState: "none", forThisBot: true } as const;

  it("strips the url query and redacts --api-key values in args", () => {
    const secret = "hunter2hunter2";
    const remoteListing = botListing("r", remote({ url: "https://mcp.example.com/mcp?key=topsecret123" }), extra);
    expect(remoteListing.url).toBe("https://mcp.example.com/mcp");
    const listing = botListing("s", stdio({ args: ["--api-key", secret, "--token", secret, `--api-key=${secret}`, "--name", "visible"] }), extra);
    expect(JSON.stringify(listing)).not.toContain(secret);
    expect(listing.args).toContain("visible");
  });

  it("reports owner managed when a policy manages the server", () => {
    const listing = botListing("s", stdio(), { ...extra, managedBy: "Acme policy" });
    expect(listing.owner).toBe("managed");
    expect(listing.managedBy).toBe("Acme policy");
  });

  it("never includes env or header values", () => {
    const text = JSON.stringify([botListing("s", stdio(), extra), botListing("r", remote(), extra)]);
    for (const value of ["sk-live-123", "k1\"", "Bearer abc", "shh"]) expect(text).not.toContain(value);
    expect(botListing("s", stdio(), extra).envKeys).toEqual(["DODO_PAYMENTS_API_KEY", "API_KEY"]);
    expect(botListing("r", remote(), extra).headerKeys).toEqual(["Authorization"]);
  });
});
