import { describe, expect, it } from "vitest";

import { accountHint, accountsByApp, missingAccountHint, withAccountHint } from "./connector-account-hint.ts";

const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const githubError = JSON.stringify({ successful: false, error: JSON.stringify({ message: "Resource not accessible by integration" }) });
const refused = {
  jsonrpc: "2.0",
  id: 7,
  result: { content: [{ type: "text", text: githubError }], isError: true },
};
const refusalFor = (slug: string, id: number) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [{ type: "text", text: JSON.stringify({ successful: false, tool_slug: slug, error: JSON.stringify({ message: "Resource not accessible by integration" }) }) }],
    isError: true,
  },
});
const accounts = {
  github: [
    { id: "github_adrue-sump", alias: "vyrgs", status: "ACTIVE" },
    { id: "github_barie-scud", alias: "personal", status: "ACTIVE" },
  ],
};
const load = async () => accounts;

describe("connector account hint", () => {
  it("names the other accounts of the app a call was refused on", async () => {
    const out = JSON.parse(decode(await withAccountHint(encode(refused), "application/json", ["GITHUB_CREATE_AN_ISSUE"], load)));
    expect(out.result.content[0]).toEqual(refused.result.content[0]);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[1].text).toContain("GitHub refused this because the connected account the call used cannot reach it");
    expect(out.result.content[1].text).toContain("not about a lack of access to GitHub");
    expect(out.result.content[1].text).toContain("vyrgs");
    expect(out.result.content[1].text).toContain("personal");
    expect(out.result.content[1].text).toContain("account field");
  });

  it("leaves a call alone when the app has one account only", async () => {
    const one = { github: [{ id: "github_barie-scud", alias: "personal", status: "ACTIVE" }] };
    const bytes = encode(refused);
    expect(await withAccountHint(bytes, "application/json", ["GITHUB_CREATE_AN_ISSUE"], async () => one)).toBe(bytes);
  });

  it("leaves an answer that is not a refusal untouched", async () => {
    const ok = encode({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "relay-ok" }] } });
    expect(await withAccountHint(ok, "application/json", ["GITHUB_CREATE_AN_ISSUE"], load)).toBe(ok);
  });

  it("leaves a refusal of another kind untouched", async () => {
    const scope = encode({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "403 Forbidden: Request had insufficient authentication scopes. ACCESS_TOKEN_SCOPE_INSUFFICIENT" }], isError: true },
    });
    expect(await withAccountHint(scope, "application/json", ["GMAIL_CREATE_FILTER"], load)).toBe(scope);
  });

  it("annotates a streamed (SSE) response", async () => {
    const body = `event: message\ndata: ${JSON.stringify(refused)}\n\n`;
    const out = decode(await withAccountHint(encode(body), "text/event-stream", ["GITHUB_CREATE_AN_ISSUE"], load));
    const frame = JSON.parse(out.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
    expect(frame.result.content).toHaveLength(2);
    expect(out.startsWith("event: message\n")).toBe(true);
  });

  it("returns an unreadable body byte for byte", async () => {
    const unreadable = encode("Resource not accessible by integration but not JSON");
    expect(await withAccountHint(unreadable, "application/json", ["GITHUB_CREATE_AN_ISSUE"], load)).toBe(unreadable);
  });

  it("names an account without an alias by its id", () => {
    const hint = accountHint(["GITHUB_CREATE_AN_ISSUE"], {
      github: [{ id: "github_one", status: "ACTIVE" }, { id: "github_two", status: "ACTIVE" }],
    });
    expect(hint).toContain("github_one");
    expect(hint).toContain("github_two");
  });

  it("counts only the accounts that can run a call", () => {
    expect(accountHint(["GITHUB_CREATE_AN_ISSUE"], {
      github: [
        { id: "github_one", alias: "personal", status: "ACTIVE" },
        { id: "github_two", alias: "old", status: "EXPIRED" },
      ],
    })).toBe("");
  });

  it("reads the accounts out of a services inventory", () => {
    const read = accountsByApp({ github: { accounts: [{ id: "github_one", alias: "personal", status: "ACTIVE" }] } });
    expect(read.github?.[0]?.alias).toBe("personal");
  });

  it("names the usable accounts of a call refused for naming no account", async () => {
    const noAccount = {
      jsonrpc: "2.0",
      id: 11,
      result: { content: [{ type: "text", text: JSON.stringify({ successful: false, error: JSON.stringify({ message: "Multiple gmail accounts connected. Specify which to use via the 'account' field: work, personal" }) }) }], isError: true },
    };
    const out = JSON.parse(decode(await withAccountHint(encode(noAccount), "application/json", ["GMAIL_FETCH_EMAILS"], async () => ({
      gmail: [
        { id: "gmail_one", alias: "work", status: "ACTIVE" },
        { id: "gmail_two", alias: "personal", status: "ACTIVE" },
      ],
    }))));
    expect(out.result.content[1].text).toContain("Gmail refused this because the call named no account");
    expect(out.result.content[1].text).toContain("2 connected accounts (work, personal)");
    expect(out.result.content[1].text).toContain("Name one of them in the call's account field");
  });

  it("names the one usable account when the others cannot run a call", async () => {
    const hint = missingAccountHint(["GMAIL_FETCH_EMAILS"], {
      gmail: [
        { id: "gmail_one", alias: "work", status: "ACTIVE" },
        { id: "gmail_two", alias: "old", status: "EXPIRED" },
      ],
    });
    expect(hint).toContain("one can run a call (work)");
    expect(hint).toContain("Name that one in the call's account field");
  });

  it("leaves a no-account refusal alone when no account of the app can run a call", () => {
    expect(missingAccountHint(["GMAIL_FETCH_EMAILS"], { gmail: [{ id: "gmail_one", alias: "old", status: "EXPIRED" }] })).toBe("");
  });

  it("leaves a no-account refusal alone when the batch mixes apps", () => {
    expect(missingAccountHint(["GMAIL_GET_PROFILE", "GITHUB_CREATE_AN_ISSUE"], accounts)).toBe("");
  });

  it("leaves an answer that matches neither refusal untouched", async () => {
    const multi = encode({ jsonrpc: "2.0", id: 12, result: { content: [{ type: "text", text: "Multiple gmail accounts connected. Specify which to use via the 'account' field: work" }], isError: true } });
    expect(await withAccountHint(multi, "application/json", ["GMAIL_FETCH_EMAILS"], async () => ({}))).toBe(multi);
  });

  it("names the app the refusal names, not the first app of the batch", async () => {
    const mixed = { github: accounts.github, gmail: [{ id: "gmail_one", alias: "work", status: "ACTIVE" }, { id: "gmail_two", alias: "other", status: "ACTIVE" }] };
    const named = { jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: JSON.stringify({ successful: false, tool_slug: "GITHUB_CREATE_AN_ISSUE", error: JSON.stringify({ message: "Resource not accessible by integration" }) }) }], isError: true } };
    const out = JSON.parse(decode(await withAccountHint(encode(named), "application/json", ["GMAIL_GET_PROFILE", "GITHUB_CREATE_AN_ISSUE"], async () => mixed)));
    expect(out.result.content[1].text).toContain("GitHub");
    expect(out.result.content[1].text).toContain("2 connected accounts (vyrgs, personal)");
  });

  it("leaves a refusal alone when it does not name its app and the batch mixes apps", async () => {
    const mixed = { github: accounts.github, gmail: [{ id: "gmail_one", alias: "work", status: "ACTIVE" }, { id: "gmail_two", alias: "other", status: "ACTIVE" }] };
    const bytes = encode(refused);
    expect(await withAccountHint(bytes, "application/json", ["GMAIL_GET_PROFILE", "GITHUB_CREATE_AN_ISSUE"], async () => mixed)).toBe(bytes);
  });

  it("gives the note to the app the refusal names even when another app of the batch has one account", async () => {
    const mixed = { github: accounts.github, gmail: [{ id: "gmail_one", alias: "work", status: "ACTIVE" }] };
    const named = { jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: JSON.stringify({ successful: false, tool_slug: "GITHUB_CREATE_AN_ISSUE", error: JSON.stringify({ message: "Resource not accessible by integration" }) }) }], isError: true } };
    const out = JSON.parse(decode(await withAccountHint(encode(named), "application/json", ["GMAIL_GET_PROFILE", "GITHUB_CREATE_AN_ISSUE"], async () => mixed)));
    expect(out.result.content[1].text).toContain("GitHub");
    expect(out.result.content[1].text).toContain("personal");
  });

  it("gives each frame of a streamed answer the note of its own app", async () => {
    const mixed = { github: accounts.github, gmail: [{ id: "gmail_one", alias: "work", status: "ACTIVE" }] };
    const body = `data: ${JSON.stringify(refusalFor("GITHUB_CREATE_AN_ISSUE", 11))}\n\ndata: ${JSON.stringify(refusalFor("GMAIL_GET_PROFILE", 12))}\n\n`;
    const out = decode(await withAccountHint(encode(body), "text/event-stream", ["GITHUB_CREATE_AN_ISSUE", "GMAIL_GET_PROFILE"], async () => mixed));
    const frames = out.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    expect(frames[0].result.content).toHaveLength(2);
    expect(frames[0].result.content[1].text).toContain("GitHub refused this");
    expect(frames[1].result.content).toHaveLength(1);
  });

  it("gives a frame its note even when the first frame's app has one account only", async () => {
    const mixed = { github: [{ id: "github_one", alias: "personal", status: "ACTIVE" }], gmail: [{ id: "gmail_one", alias: "work", status: "ACTIVE" }, { id: "gmail_two", alias: "other", status: "ACTIVE" }] };
    const body = `data: ${JSON.stringify(refusalFor("GITHUB_CREATE_AN_ISSUE", 13))}\n\ndata: ${JSON.stringify(refusalFor("GMAIL_GET_PROFILE", 14))}\n\n`;
    const out = decode(await withAccountHint(encode(body), "text/event-stream", ["GITHUB_CREATE_AN_ISSUE", "GMAIL_GET_PROFILE"], async () => mixed));
    const frames = out.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    expect(frames[0].result.content).toHaveLength(1);
    expect(frames[1].result.content).toHaveLength(2);
    expect(frames[1].result.content[1].text).toContain("Gmail refused this");
    expect(frames[1].result.content[1].text).toContain("work, other");
  });
});
