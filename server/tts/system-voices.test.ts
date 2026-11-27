import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { synthesizeSystem, type Runner } from "./system-voices.ts";

describe("synthesizeSystem", () => {
  it("passes the text after `--`, so text that looks like an option is spoken, never parsed", async () => {
    for (const text of ["--input-file=/etc/hosts", "--output-file=/tmp/victim", "- item", "-v Alex", "hello"]) {
      const calls: string[][] = [];
      const run: Runner = async (_file, args) => {
        calls.push(args);
        await writeFile(args[args.indexOf("-o") + 1], "RIFF");
        return { stdout: "" };
      };
      await synthesizeSystem(`  ${text}  `, "Samantha", run);
      expect(calls).toHaveLength(1);
      expect(calls[0].slice(-2), text).toEqual(["--", text]);
      expect(calls[0].filter((arg) => arg.startsWith("--input-file") || arg.startsWith("--output-file")).length, text)
        .toBe(text.startsWith("--") ? 1 : 0);
    }
  });
});
