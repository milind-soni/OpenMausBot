import { describe, expect, it } from "vitest";

import { relayToken, storedMcpAuth } from "./mcp-catalog-auth.ts";
import type { ServiceCredential } from "./included-services.ts";

const SCIENCE = "https://cloud.example.com/api/cloud/services/science";
const cred: ServiceCredential = { token: "omb_sd_fixture", api: SCIENCE, included: true };

describe("relayToken", () => {
  it("injects for any server under the relay base", () => {
    expect(relayToken(`${SCIENCE}/pubmed/mcp`, cred)).toBe(cred.token);
    expect(relayToken(`${SCIENCE}/pubmed/mcp`, { ...cred, api: `${SCIENCE}/` })).toBe(cred.token);
    for (const url of [
      `${SCIENCE}x/pubmed/mcp`,
      SCIENCE,
      `${SCIENCE}/pubmed/mcp?a=1`,
      `${SCIENCE}/pubmed/mcp#x`,
      `https://user:pw@cloud.example.com/api/cloud/services/science/pubmed/mcp`,
      `${SCIENCE}/../other/mcp`,
      `${SCIENCE}/%2e%2e/other/mcp`,
      "https://elsewhere.example.com/api/cloud/services/science/pubmed/mcp",
      "http://cloud.example.com/api/cloud/services/science/pubmed/mcp",
      "not a url",
    ]) expect(relayToken(url, cred), url).toBeNull();
    expect(relayToken(`${SCIENCE}/pubmed/mcp`, null)).toBeNull();
  });
});

const config = (mcpServers: Record<string, unknown>) => () => ({ mcpServers }) as never;
const cloudEntry = (url: string) => ({ type: "http", url, catalog: { id: "pubmed", auth: "cloud" } });

describe("storedMcpAuth", () => {
  it("a marked cloud entry without a usable token needs Max", () => {
    const servers = { pubmed: cloudEntry(`${SCIENCE}/pubmed/mcp`), other: cloudEntry("https://elsewhere.example.com/mcp") };
    const none = storedMcpAuth(config(servers), () => null);
    expect(none.cloud("pubmed", `${SCIENCE}/pubmed/mcp`)).toBe("needs-max");
    const held = storedMcpAuth(config(servers), () => cred);
    expect(held.cloud("pubmed", `${SCIENCE}/pubmed/mcp`)).toEqual({ token: cred.token });
    expect(held.cloud("other", "https://elsewhere.example.com/mcp")).toBe("needs-max");
  });

  it("hand-added entries under the base get the token; unmarked ones elsewhere are untouched", () => {
    const auth = storedMcpAuth(config({ mine: { type: "http", url: `${SCIENCE}/chembl/mcp` }, plain: { type: "http", url: "https://x.example.com/mcp" } }), () => cred);
    expect(auth.cloud("mine", `${SCIENCE}/chembl/mcp`)).toEqual({ token: cred.token });
    expect(auth.cloud("plain", "https://x.example.com/mcp")).toBeNull();
  });

  it("is null for oauth and tenant entries and survives entries without a url", () => {
    const auth = storedMcpAuth(config({
      a: { type: "http", url: "https://a.example.com/mcp", catalog: { id: "consensus", auth: "oauth" } },
      b: { type: "http", url: "https://b.mcp.benchling.com/mcp", catalog: { id: "benchling", auth: "tenant" } },
      c: { command: "x", catalog: { id: "pubmed", auth: "cloud" } },
      d: "junk",
    }), () => null);
    expect(auth.cloud("a", "https://a.example.com/mcp")).toBeNull();
    expect(auth.cloud("b", "https://b.mcp.benchling.com/mcp")).toBeNull();
    expect(auth.cloud("c", `${SCIENCE}/pubmed/mcp`)).toBeNull();
    expect(auth.cloud("d", `${SCIENCE}/pubmed/mcp`)).toBeNull();
    expect(auth.cloud("missing", `${SCIENCE}/pubmed/mcp`)).toBeNull();
  });

  it("clients() returns the stored oauth app only for the same url", () => {
    const oauth = { clientId: "id", clientSecret: "s" };
    const auth = storedMcpAuth(config({ docs: { type: "http", url: "https://d.example.com/mcp", oauth } }), () => null);
    expect(auth.clients("docs", "https://d.example.com/mcp")).toMatchObject({ clientId: "id" });
    expect(auth.clients("docs", "https://e.example.com/mcp")).toBeUndefined();
    expect(auth.clients("nope", "https://d.example.com/mcp")).toBeUndefined();
  });
});
