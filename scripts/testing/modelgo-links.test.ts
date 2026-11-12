// The sponsor counts its clicks by one tracked address, so nothing clickable in the app may reach its site any other way.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODELGO_URL } from "../../shared/modelgo.ts";
import { CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";
import { ModelgoDriver } from "../../server/drivers/modelgo.ts";

const ROOT = new URL("../../", import.meta.url);
const API_BASE = "https://api.modelgo.ai/v1";
const MENTION = /(?:https?:\/\/)?(?:[\w-]+\.)*modelgo\.ai[^\s"'`)\]<>]*/gi;
const lines = (file: string) => readFileSync(new URL(file, ROOT), "utf8").split("\n");
const isComment = (line: string) => /^\s*(?:\/\/|\/?\*)/.test(line) || /^\s*\/\*\*.*\*\/\s*$/.test(line);
const files = (...paths: string[]) => execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", ...paths], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((file) => /\.(ts|tsx|mjs|json)$/.test(file) && !file.includes(".test."));
const mentions = (file: string) => lines(file).filter((line) => !isComment(line)).flatMap((line) => line.match(MENTION) ?? []);

describe("links to ModelGo's site", () => {
  it("is the exact address the sponsor asked for", () => {
    expect(MODELGO_URL).toBe("https://modelgo.ai/?utm_source=openmausbot&utm_medium=sponsorship&utm_content=app&campaign_id=openmausbot&ad_group_id=app");
  });

  it("is the only ModelGo address anywhere in src/ and shared/", () => {
    const found = files("src", "shared").flatMap((file) => mentions(file).map((mention) => [file, mention]));
    expect(found.filter(([, mention]) => mention !== MODELGO_URL)).toEqual([]);
    expect(found.map(([file]) => file)).toEqual(["shared/modelgo.ts"]);
  });

  it("is the only link the driver and the secret card offer; the server otherwise names only the API base", () => {
    expect(ModelgoDriver.install?.docsUrl).toBe(MODELGO_URL);
    expect(CREDENTIAL_TARGETS.modelgoApiKey.helpUrl).toBe(MODELGO_URL);
    const found = files("server").flatMap((file) => mentions(file).map((mention) => [file, mention]));
    expect(found.filter(([, mention]) => mention !== API_BASE)).toEqual([]);
  });
});
