import { describe, expect, it } from "vitest";

import { parseMcpArguments, parseMcpEnvironment } from "./McpServersPanel";

describe("MCP server form", () => {
  it("uses one explicit argument per line", () => {
    expect(parseMcpArguments("-y\n  @scope/server  \n\n--read-only")).toEqual([
      "-y",
      "@scope/server",
      "--read-only",
    ]);
  });

  it("preserves write-only saved values without putting them back in the form", () => {
    expect(parseMcpEnvironment("TOKEN=\nMODE=read-only", ["TOKEN"])).toEqual({
      ok: true,
      env: { TOKEN: true, MODE: "read-only" },
    });
  });

  it("rejects malformed and duplicate environment names", () => {
    expect(parseMcpEnvironment("NOT A KEY=value")).toEqual({
      ok: false,
      error: "“NOT A KEY” is not a valid environment variable.",
    });
    expect(parseMcpEnvironment("TOKEN=one\nTOKEN=two")).toEqual({
      ok: false,
      error: "“TOKEN” is listed more than once.",
    });
  });
});
