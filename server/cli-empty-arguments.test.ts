import { describe, expect, it } from "vitest";

import { splitCliString } from "./env-path.ts";
import { execCli } from "./procs.ts";

describe("empty fixed CLI arguments", () => {
  it.each(['tool --label "" next', "tool --label '' next"])("keeps an explicitly empty option value in %s", (command) => {
    expect(splitCliString(command)).toEqual(["tool", "--label", "", "next"]);
  });

  it("keeps adjacent empty quoted arguments separate", () => {
    expect(splitCliString('tool "" \'\'')).toEqual(["tool", "", ""]);
  });

  it("still joins quoted fragments into one argument and ignores unquoted spacing", () => {
    expect(splitCliString('  tool  pre""fix  "two words"  ')).toEqual(["tool", "prefix", "two words"]);
    expect(splitCliString("  \t  ")).toEqual([]);
  });

  it("passes an empty fixed value to the real child before invocation arguments", async () => {
    const cli = `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" ""`;
    const result = await new Promise<{ error: Error | null; stdout: string }>((resolve) => {
      execCli(cli, ["tail", ""], { timeout: 5_000 }, (error, stdout) => resolve({ error, stdout }));
    });
    expect(result.error).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual(["", "tail", ""]);
  });
});
