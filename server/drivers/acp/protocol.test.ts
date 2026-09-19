// Unit tests for the AcpConnection read loop's lifecycle guarantees: nothing
// dispatches after close(), the buffer cannot grow once closed, a throwing
// onResult settles its request instead of stranding it, frames dispatch in
// wire order around an oversized line, only JSON-RPC 2.0 envelopes reach
// handlers, and a throwing observer never unwinds protocol state.
// Driver-level behavior stays in acp.test.ts against the fake CLI.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { AcpConnection, type AcpConnectionOptions } from "./protocol.ts";

/** One agent→client line, framed the way the wire speaks it. */
const frame = (message: object) => `${JSON.stringify(message)}\n`;

/** An in-memory agent: outgoing frames land in `written`, test code speaks
 *  through `stdout`, and extra options override the defaults. */
function makeConnection(options: Partial<AcpConnectionOptions> = {}) {
  const written: string[] = [];
  const stdout = new PassThrough();
  const connection = new AcpConnection({
    write: (line) => written.push(line),
    stdout,
    ...options,
  });
  return { connection, stdout, written };
}

describe("AcpConnection post-close read loop", () => {
  it("ignores stdout chunks after close()", () => {
    const chunks: string[] = [];
    const notifications: string[] = [];
    const { connection, stdout } = makeConnection({
      onData: (chunk) => chunks.push(chunk),
      onNotification: (message) => notifications.push(message.method ?? ""),
    });
    stdout.write(frame({ jsonrpc: "2.0", method: "before" }));
    connection.close();
    stdout.write(frame({ jsonrpc: "2.0", method: "after" }));
    expect(chunks).toEqual([frame({ jsonrpc: "2.0", method: "before" })]);
    expect(notifications).toEqual(["before"]);
  });

  it("drops the buffered partial line when an oversized frame closes the connection", () => {
    let closes = 0;
    const notifications: string[] = [];
    const { connection, stdout } = makeConnection({
      maxLineBytes: 16,
      onClose: () => {
        closes += 1;
      },
      onNotification: (message) => notifications.push(message.method ?? ""),
    });
    // a partial line with no newline is oversized `rest`, never dispatched
    stdout.write(JSON.stringify({ method: "way-too-long-to-frame" }));
    expect(connection.isClosed).toBe(true);
    stdout.write(frame({ jsonrpc: "2.0", method: "later" }));
    expect(closes).toBe(1);
    expect(notifications).toEqual([]);
  });

  it("fails pending requests and closes when a callback throws in the stream listener", async () => {
    const onClose = vi.fn();
    const { connection, stdout } = makeConnection({
      onNotification: () => {
        throw new Error("observer exploded");
      },
      onClose,
    });
    const pending = connection.request("session/request", {});
    stdout.write(frame({ jsonrpc: "2.0", method: "boom" }));
    await expect(pending).rejects.toThrow(/observer exploded/);
    expect(connection.isClosed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fails pending requests, closes, and calls onHostReadError when stdout errors", async () => {
    const onHostReadError = vi.fn();
    const { connection, stdout } = makeConnection({ onHostReadError });
    const pending = connection.request("session/prompt", {});
    stdout.emit("error", new Error("read EIO"));
    await expect(pending).rejects.toThrow(/ACP agent stdout failed/);
    expect(connection.isClosed).toBe(true);
    expect(onHostReadError).toHaveBeenCalledTimes(1);
    expect(onHostReadError.mock.calls[0][0]).toMatchObject({ message: "read EIO" });
  });

  it("closes the connection when onData throws", () => {
    const { connection, stdout } = makeConnection({
      onData: () => {
        throw new Error("chunk handler exploded");
      },
    });
    stdout.write(frame({ jsonrpc: "2.0", method: "dropped" }));
    expect(connection.isClosed).toBe(true);
  });

    it("stops dispatch when onData closes the connection", () => {
    const notifications: string[] = [];
    const { connection, stdout } = makeConnection({
      onData: () => connection.close(),
      onNotification: (message) => notifications.push(message.method ?? ""),
    });
    stdout.write(frame({ jsonrpc: "2.0", method: "dropped" }));
    expect(notifications).toEqual([]);
  });

  it("stops dispatch when onLine closes the connection", () => {
    const messages: string[] = [];
    const { connection, stdout } = makeConnection({
      onLine: () => {
        connection.close();
        return false;
      },
      onMessage: (message) => messages.push(message.method ?? ""),
    });
    stdout.write(frame({ jsonrpc: "2.0", method: "dropped" }));
    expect(messages).toEqual([]);
  });

  it("stops later lines after a dispatch callback closes the connection", () => {
    const notifications: string[] = [];
    const { connection, stdout } = makeConnection({
      onNotification: (message) => {
        notifications.push(message.method ?? "");
        connection.close();
      },
    });
    stdout.write(frame({ jsonrpc: "2.0", method: "first" }) + frame({ jsonrpc: "2.0", method: "second" }));
    expect(notifications).toEqual(["first"]);
  });

  it("stops later lines after onResult closes the connection", async () => {
    const notifications: string[] = [];
    const { connection, stdout } = makeConnection({
      onNotification: (message) => notifications.push(message.method ?? ""),
    });
    const promise = connection.request("session/prompt", {}, undefined, () => connection.close());
    stdout.write(frame({ jsonrpc: "2.0", id: 1, result: null }) + frame({ jsonrpc: "2.0", method: "after" }));
    await expect(promise).resolves.toBeNull();
    expect(notifications).toEqual([]);
  });
});

describe("AcpConnection request callbacks", () => {
  it("rejects the request when onResult throws", async () => {
    const notifications: string[] = [];
    const { connection, stdout } = makeConnection({
      onNotification: (message) => notifications.push(message.method ?? ""),
    });
    const promise = connection.request("session/prompt", {}, undefined, () => {
      throw new Error("callback exploded");
    });
    stdout.write(frame({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    await expect(promise).rejects.toThrow("callback exploded");
    // the read loop survives the throw and keeps dispatching later lines
    stdout.write(frame({ jsonrpc: "2.0", method: "still-alive" }));
    expect(notifications).toEqual(["still-alive"]);
  });

  it("resolves the request when onResult returns normally", async () => {
    const seen: unknown[] = [];
    const { connection, stdout } = makeConnection();
    const promise = connection.request("session/prompt", {}, undefined, (result) => {
      seen.push(result);
    });
    stdout.write(frame({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    await expect(promise).resolves.toEqual({ ok: true });
    expect(seen).toEqual([{ ok: true }]);
  });
});

describe("AcpConnection line ordering under maxLineBytes", () => {
  it("dispatches valid frames that precede an oversized line before failing", async () => {
    const { connection, stdout } = makeConnection({ maxLineBytes: 96 });
    const first = connection.request("session/prompt", {});
    const second = connection.request("session/prompt", {});
    const oversized = JSON.stringify({ jsonrpc: "2.0", method: "x".repeat(96) });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(96);
    stdout.write(frame({ jsonrpc: "2.0", id: 1, result: "first" }) + oversized + "\n" + frame({ jsonrpc: "2.0", id: 2, result: "dropped" }));
    await expect(first).resolves.toBe("first");
    await expect(second).rejects.toThrow("too large");
    expect(connection.isClosed).toBe(true);
  });

  it("checks the unterminated tail only after complete lines have dispatched", async () => {
    const { connection, stdout } = makeConnection({ maxLineBytes: 96 });
    const promise = connection.request("session/prompt", {});
    stdout.write(frame({ jsonrpc: "2.0", id: 1, result: null }) + "x".repeat(120));
    await expect(promise).resolves.toBeNull();
    expect(connection.isClosed).toBe(true);
  });
});

describe("AcpConnection JSON-RPC envelope validation", () => {
  it("does not let a frame without a 2.0 envelope resolve a pending request", async () => {
    const { connection, stdout } = makeConnection();
    const promise = connection.request("session/prompt", {});
    stdout.write(frame({ id: 1, result: "unlabelled" }) + frame({ jsonrpc: "1.0", id: 1, result: "mislabeled" }));
    stdout.write(frame({ jsonrpc: "2.0", id: 1, result: "genuine" }));
    await expect(promise).resolves.toBe("genuine");
  });

  it("keeps unlabelled requests away from handlers but honors id: null requests", () => {
    const requests: string[] = [];
    const notifications: string[] = [];
    const { stdout } = makeConnection({
      onServerRequest: (message) => requests.push(message.method ?? ""),
      onNotification: (message) => notifications.push(message.method ?? ""),
    });
    stdout.write(frame({ id: null, method: "fs/write_text_file", params: {} }));
    stdout.write(frame({ jsonrpc: "2.0", id: null, method: "fs/write_text_file", params: {} }));
    stdout.write(frame({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }));
    expect(requests).toEqual(["fs/write_text_file"]);
    expect(notifications).toEqual(["notifications/cancelled"]);
  });

  it("replies Invalid Request to requests with unsupported id types", () => {
    const requests: string[] = [];
    const { stdout, written } = makeConnection({
      onServerRequest: (message) => requests.push(message.method ?? ""),
    });
    stdout.write(frame({ jsonrpc: "2.0", id: true, method: "fs/write_text_file", params: {} }));
    stdout.write(frame({ jsonrpc: "2.0", id: {}, method: "fs/write_text_file", params: {} }));
    stdout.write(frame({ jsonrpc: "2.0", id: null, method: "fs/read_text_file", params: {} }));
    expect(requests).toEqual(["fs/read_text_file"]);
    const invalidRequest = frame({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    expect(written).toEqual([invalidRequest, invalidRequest]);
  });
});

describe("AcpConnection observer containment", () => {
  it("keeps a written request pending when the onSend observer throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connection, stdout } = makeConnection({
      onSend: () => {
        throw new Error("observer exploded");
      },
    });
    const promise = connection.request("session/prompt", {});
    stdout.write(frame({ jsonrpc: "2.0", id: 1, result: "written-anyway" }));
    await expect(promise).resolves.toBe("written-anyway");
    vi.restoreAllMocks();
  });

  it("keeps dispatching when the onMessage observer throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notifications: string[] = [];
    const { connection, stdout } = makeConnection({
      onMessage: () => {
        throw new Error("observer exploded");
      },
      onNotification: (message) => notifications.push(message.method ?? ""),
    });
    const promise = connection.request("session/prompt", {});
    stdout.write(frame({ jsonrpc: "2.0", id: 1, result: null }) + frame({ jsonrpc: "2.0", method: "still-alive" }));
    await expect(promise).resolves.toBeNull();
    expect(notifications).toEqual(["still-alive"]);
    vi.restoreAllMocks();
  });
});

describe("AcpConnection response validation", () => {
  it("bounds a provider error message and marks the cut", async () => {
    const { connection, stdout } = makeConnection();
    const promise = connection.request("session/prompt", {});
    stdout.write(frame({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x".repeat(1024 * 1024) } }));
    const failure = await promise.then(
      () => {
        throw new Error("expected the provider error to reject");
      },
      (error: Error) => error,
    );
    expect(failure.message.length).toBeLessThanOrEqual(512 + "…[truncated]".length);
    expect(failure.message.endsWith("…[truncated]")).toBe(true);
  });

  it("uses the fixed fallback when a provider error carries no message", async () => {
    const { connection, stdout } = makeConnection();
    const promise = connection.request("session/prompt", {});
    stdout.write(frame({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }));
    await expect(promise).rejects.toThrow("ACP provider error");
  });
  it("rejects instead of resolving when a response carries error: null", async () => {
    const { connection, stdout } = makeConnection();
    const promise = connection.request("session/prompt", {});
    stdout.write(frame({ jsonrpc: "2.0", id: 1, error: null }));
    await expect(promise).rejects.toThrow(/invalid error response/i);
  });

  it("rejects a non-object error value instead of reading its fields", async () => {
    const { connection, stdout } = makeConnection();
    const promise = connection.request("session/prompt", {});
    stdout.write(frame({ jsonrpc: "2.0", id: 1, error: "boom" }));
    await expect(promise).rejects.toThrow(/invalid error response/i);
  });
});
