import { describe, expect, it } from "vitest";

import { parseArgs, parseEnvLines } from "@/components/McpServersCard";

describe("parseArgs", () => {
  it("splits on whitespace and drops the gaps", () => {
    expect(parseArgs("  -y  @scope/pkg   --root ~/work ")).toEqual(["-y", "@scope/pkg", "--root", "~/work"]);
    expect(parseArgs("")).toEqual([]);
  });
});

describe("parseEnvLines", () => {
  it("reads KEY=value lines and keeps everything after the first =", () => {
    expect(parseEnvLines("API_TOKEN=abc=123\nREGION=eu")).toEqual({ API_TOKEN: "abc=123", REGION: "eu" });
  });

  it("ignores a line that names no variable, rather than saving an empty one", () => {
    expect(parseEnvLines("just some text\n=novalue\n\nOK=1")).toEqual({ OK: "1" });
  });
});
