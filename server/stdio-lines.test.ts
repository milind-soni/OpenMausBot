import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStdioLines } from "./stdio-lines.ts";

function collect() {
  const input = new PassThrough();
  const lines: string[] = [];
  let closed = 0;
  const reader = readStdioLines(input, (line) => lines.push(line), () => { closed++; });
  return { input, lines, reader, closed: () => closed };
}

describe("readStdioLines", () => {
  it("keeps a frame whole when a string in it holds a raw U+2028 or U+2029", () => {
    const { input, lines } = collect();
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: { command: "a b c" } } });
    input.write(`${frame}\n`);
    expect(lines).toEqual([frame]);
    expect(JSON.parse(lines[0]).params.arguments.command).toBe("a b c");
  });

  it("splits on \\n only, drops a trailing \\r, and joins a frame or character cut across chunks", () => {
    const { input, lines } = collect();
    const bytes = Buffer.from("{\"a\":\"é\"}\r\n{\"b\":1}\n\n");
    input.write(bytes.subarray(0, 7));
    input.write(bytes.subarray(7));
    expect(lines).toEqual(["{\"a\":\"é\"}", "{\"b\":1}", ""]);
  });

  it("delivers an unterminated last frame at end of input, then reports the close once", async () => {
    const { input, lines, closed } = collect();
    input.end("{\"last\":true}");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(["{\"last\":true}"]);
    expect(closed()).toBe(1);
  });

  it("delivers nothing more after close", () => {
    const { input, lines, reader, closed } = collect();
    input.write("one\n");
    reader.close();
    input.write("two\n");
    expect(lines).toEqual(["one"]);
    expect(closed()).toBe(1);
  });

  it("never delivers a line twice when a handler throws", () => {
    const input = new PassThrough();
    const lines: string[] = [];
    readStdioLines(input, (line) => {
      lines.push(line);
      if (line === "bad") throw new Error("handler failed");
    });
    expect(() => input.emit("data", Buffer.from("one\nbad\nthree\nfour"))).toThrow("handler failed");
    input.emit("data", Buffer.from("\n"));
    expect(lines).toEqual(["one", "bad", "three", "four"]);
  });
});
