import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acpHandshake } from "./engine-handshake.ts";
import { killCliTree, spawnCli } from "./procs.ts";

vi.mock("./procs.ts", () => ({ spawnCli: vi.fn(), killCliTree: vi.fn(async () => true) }));

afterEach(() => vi.clearAllMocks());

function fixture() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  vi.mocked(spawnCli).mockReturnValue(child as ReturnType<typeof spawnCli>);
  const answer = () => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
  return { child, answer };
}

describe("engine update handshake input errors", () => {
  it.each(["EPIPE", "ERR_STREAM_DESTROYED"])("reports %s instead of emitting an unhandled stdin error", async (code) => {
    const { child, answer } = fixture();
    const result = acpHandshake("fixture-agent", ["acp"], {});
    const error = Object.assign(new Error(`fixture input closed: ${code}`), { code });
    try {
      expect(() => child.stdin.emit("error", error)).not.toThrow();
      // Output already buffered by a child that exited must not turn the failed write into a passing handshake.
      answer();
      expect(await result).toBe(error.message);
      expect(killCliTree).toHaveBeenCalledExactlyOnceWith(child, 2_000);
      child.emit("exit", 1);
      expect(killCliTree).toHaveBeenCalledTimes(1);
    } finally {
      answer();
      await result;
    }
  });

  it("keeps a completed handshake settled when closing the child later errors its input", async () => {
    const { child, answer } = fixture();
    const result = acpHandshake("fixture-agent", ["acp"], {});
    answer();
    expect(await result).toBeNull();
    expect(() => child.stdin.emit("error", new Error("late input close"))).not.toThrow();
    expect(killCliTree).toHaveBeenCalledTimes(1);
  });

  it("continues to report a child process launch error", async () => {
    const { child } = fixture();
    const result = acpHandshake("fixture-agent", ["acp"], {});
    child.emit("error", new Error("fixture launch error"));
    expect(await result).toBe("fixture launch error");
    expect(killCliTree).toHaveBeenCalledTimes(1);
  });
});
