import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

// Some providers allow only loopback redirects, so their sign-in is completed by paste-back under Apps → MCP servers.
const DIR = __dirname;
const pack = (file: string) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as Record<string, string | undefined>;
const en = pack("en.json");

it("sends the person to Apps → MCP servers, where the paste-back sign-in is", () => {
  expect(en["server.mcp.signIn.inSettings"], "en.json").toBeDefined();
  for (const file of readdirSync(DIR).filter((name) => name.endsWith(".json") && name !== "source-hashes.json")) {
    const words = pack(file);
    const sentence = words["server.mcp.signIn.inSettings"];
    if (sentence === undefined) continue;
    const apps = words["sidebar.nav.apps"] ?? en["sidebar.nav.apps"];
    const servers = words["connectors.tab.mcp"] ?? en["connectors.tab.mcp"];
    expect(sentence, file).toContain(`${apps} → ${servers}`);
  }
});
