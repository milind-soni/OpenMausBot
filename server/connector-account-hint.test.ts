import { describe, expect, it } from "vitest";

import { accountHint, accountsByApp, withAccountHint } from "./connector-account-hint.ts";

const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const githubError = JSON.stringify({ successful: false, error: JSON.stringify({ message: "Resource not accessible by integration" }) });
const refused = {
  jsonrpc: "2.0",
  id: 7,
  result: { content: [{ type: "text", text: githubError }], isError: true },
};
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
});
