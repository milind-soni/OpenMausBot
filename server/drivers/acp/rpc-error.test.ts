import { describe, expect, it } from "vitest";
import { acpMissingSession, acpRpcError } from "./rpc-error.ts";

describe("acpMissingSession", () => {
  const cursor = "a09518ea-61e5-4534-8575-afbdb784a4b5";

  it("accepts OpenCode's invalidParams that carry only the rejected session id", () => {
    expect(acpMissingSession({ data: { sessionId: cursor } }, cursor)).toBe(true);
    expect(acpMissingSession({ data: { sessionId: cursor, model: "gone" } }, cursor)).toBe(false);
  });

  it("accepts Cursor's session/load message, which names the id and not a data field", () => {
    const error = acpRpcError({ code: -32602, message: `Invalid params: Session "${cursor}" not found` }, "session/load");
    expect(acpMissingSession(error, cursor)).toBe(true);
  });

  it("does not treat a bare invalidParams or another missing id as this session", () => {
    expect(acpMissingSession(acpRpcError({ code: -32602, message: "Invalid params" }, "session/load"), cursor)).toBe(false);
    expect(acpMissingSession(acpRpcError({ code: -32602, message: "Invalid params: model not found" }, "session/load"), cursor)).toBe(false);
    expect(acpMissingSession(acpRpcError({ code: -32602, message: `model gone not found for session "${cursor}"` }, "session/load"), cursor)).toBe(false);
    expect(acpMissingSession(acpRpcError({ code: -32602, message: `Invalid params: Session "${cursor}" not found` }, "session/prompt"), cursor)).toBe(false);
    expect(acpMissingSession(acpRpcError({ code: -32602, message: "Invalid params: Session \"session-10\" not found" }, "session/load"), "session-1")).toBe(false);
  });

  it("reads the session id from the full diagnostic after the shown error is cut", () => {
    const error = acpRpcError({
      code: -32602,
      message: `${"x".repeat(1600)} Invalid params: Session "${cursor}" not found`,
    }, "session/load");
    expect(error.message.length).toBe(1500);
    expect(error.message.includes(cursor)).toBe(false);
    expect(acpMissingSession(error, cursor)).toBe(true);
  });
});
