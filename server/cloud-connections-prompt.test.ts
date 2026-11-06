import { describe, expect, it, vi } from "vitest";

import { createConnectionPrompt, type ConnectionPromptSources } from "./cloud-connections-prompt.ts";
import type { McpAuthState } from "./mcp-oauth.ts";

const ORIGIN = "https://omb-u-1.fly.dev";
const SERVERS = {
  dodo: { command: "npx", args: ["-y", "dodopayments-mcp"], env: {}, enabled: true },
  linear: { type: "http", url: "https://mcp.linear.app/sse", headers: {}, enabled: true },
  jira: { type: "http", url: "https://mcp.atlassian.com/v1/sse", headers: {}, oauth: { clientId: "c" }, enabled: true },
  notes: { type: "http", url: "http://127.0.0.1:9/mcp", headers: {}, enabled: true, runsOn: { environmentId: "env-1", label: "Milind's MacBook" } },
  off: { type: "http", url: "https://mcp.off.example/mcp", headers: {}, enabled: false },
};

function sources(auth: Record<string, McpAuthState> = {}, connected: Record<string, boolean> = {}): ConnectionPromptSources & { reads: string[][] } {
  const reads: string[][] = [];
  return {
    reads,
    mcpServers: () => SERVERS,
    mcpAuth: (name) => auth[name] ?? "none",
    composioConnected: async (slugs) => { reads.push(slugs); return Object.fromEntries(slugs.map((slug) => [slug, connected[slug] === true])); },
  };
}

describe("what a bot on My Cloud is told about connections that need the person", () => {
  it("a server to sign in to, with its link, and one that runs on the person's computer, only of those the bot uses", () => {
    const prompt = createConnectionPrompt(sources({ linear: "needs-sign-in", jira: "none", off: "needs-sign-in" }), ORIGIN);
    expect(prompt({})).toBe(
      " Not connected on My Cloud yet: linear (sign in here: https://omb-u-1.fly.dev/?connect=mcp%3Alinear); jira (sign in here: https://omb-u-1.fly.dev/?connect=mcp%3Ajira)."
      + " When a task needs one, say in plain words that it needs the person once on My Cloud and give its link; do not try another way."
      + " Runs only on the person's computer Milind's MacBook, not on My Cloud: notes (it uses files or an address only Milind's MacBook has). It worked there before the bots moved here. If a task needs one, tell the person in plain words that it stayed on Milind's MacBook and why, not that it was never set up, and do not write your own replacement.");
    expect(prompt({ mcpServers: ["dodo", "notes"] })).toBe(" Runs only on the person's computer Milind's MacBook, not on My Cloud: notes (it uses files or an address only Milind's MacBook has). It worked there before the bots moved here. If a task needs one, tell the person in plain words that it stayed on Milind's MacBook and why, not that it was never set up, and do not write your own replacement.");
    expect(prompt({ mcpServers: ["dodo", "off"] })).toBe("");
  });

  it("in a turn, a server on the person's computer is named only when it can't be reached now, with the reason lending gives", () => {
    const prompt = createConnectionPrompt(sources(), ORIGIN);
    expect(prompt({ mcpServers: ["notes"] }, new Map()), "reached through the lent computer: nothing to say").toBe("");
    const offline = "notes runs on your Mac (Milind's MacBook), which is offline right now: OpenMausBot on it is closed, or the Mac is asleep or off.";
    expect(prompt({ mcpServers: ["notes"] }, new Map([["notes", offline]]))).toBe(
      ` Runs on the person's own computer and can't be reached now: ${offline} If a task needs one, tell the person that in plain words, and do not write your own replacement.`);
  });

  it("says nothing of a server signed in here, or one that needs no sign-in", () => {
    const prompt = createConnectionPrompt(sources({ linear: "signed-in", jira: "signed-in" }), ORIGIN);
    expect(prompt({ mcpServers: ["dodo", "linear", "jira"] })).toBe("");
  });

  it("connected apps assigned to the bot but not connected here, read in the background for the next turn", async () => {
    const source = sources({}, { gmail: false, slack: true });
    const prompt = createConnectionPrompt(source, ORIGIN);
    const bot = { mcpServers: [], connectorTools: { gmail: { tools: "*" as const }, slack: { tools: "*" as const } } };
    expect(prompt(bot)).toBe("");
    await vi.waitFor(() => expect(source.reads).toEqual([["gmail", "slack"]]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompt(bot)).toContain(" Assigned to this bot but not connected on My Cloud yet: Gmail. When a task needs one, call COMPOSIO_MANAGE_CONNECTIONS for it,"
      + " which shows the person a card to connect it, and end the turn.");
    // Read at most every 20 seconds: that turn asked nothing again.
    expect(source.reads).toHaveLength(1);
    expect(prompt({ ...bot, composio: false })).not.toContain("Gmail");
  });

  it("a connected-apps read that failed is not tried again on every turn", async () => {
    let asked = 0;
    const prompt = createConnectionPrompt({ ...sources(), composioConnected: async () => { asked++; throw new Error("The connected-apps service is unavailable."); } }, ORIGIN);
    const bot = { mcpServers: [], connectorTools: { gmail: { tools: "*" as const } } };
    expect(prompt(bot)).toBe("");
    await vi.waitFor(() => expect(asked).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompt(bot)).toBe("");
    expect(asked).toBe(1);
  });

  it("once its bots moved here, each bot knows what stayed on the computer they came from, and nobody is told before", () => {
    const quiet = { mcpServers: () => ({}), mcpAuth: () => "none" as const, composioConnected: async () => ({}) };
    expect(createConnectionPrompt({ ...quiet, movedFrom: () => null }, ORIGIN)({})).toBe("");
    const line = createConnectionPrompt({ ...quiet, movedFrom: () => "MacBook Air" }, ORIGIN)({});
    expect(line).toContain("You moved to My Cloud from the person's computer MacBook Air");
    expect(line).toContain("passkeys");
    expect(line).toContain("say in plain words that it stayed there");
  });
});
