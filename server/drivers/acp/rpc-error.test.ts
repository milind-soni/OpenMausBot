import { describe, expect, it } from "vitest";
import { addHeldSecretScrubber } from "../../redact.ts";
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

  it("matches the original message when redaction removes the session id from what is shown", () => {
    const remove = addHeldSecretScrubber((text) => text.split(cursor).join("«secret»"));
    try {
      const error = acpRpcError({ code: -32602, message: `Invalid params: Session "${cursor}" not found` }, "session/load");
      const shown = error as Error & { acpDiagnostic?: string };
      expect(shown.message.includes(cursor)).toBe(false);
      expect(shown.acpDiagnostic?.includes(cursor)).toBe(false);
      expect(acpMissingSession(error, cursor)).toBe(true);
    } finally {
      remove();
    }
  });

  it("compares the session id as written, and still accepts either case in the surrounding words", () => {
    const upper = cursor.toUpperCase();
    const error = acpRpcError({ code: -32602, message: `invalid params: SESSION "${upper}" NOT FOUND` }, "session/load");
    expect(acpMissingSession(error, upper)).toBe(true);
    expect(acpMissingSession(error, cursor)).toBe(false);
  });

  it("does not treat an earlier missing-session line quoted inside another error as this failure", () => {
    const error = acpRpcError({
      code: -32602,
      message: "Invalid params: model not found",
      data: { details: `Session "${cursor}" not found (session/load)` },
    }, "session/load");
    expect(acpMissingSession(error, cursor)).toBe(false);
  });
});
