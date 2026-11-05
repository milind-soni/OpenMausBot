import { describe, expect, it } from "vitest";
import { chatNotice } from "./chat-notices.ts";
import { createDesktopComputer, DESKTOP_COMPUTER_GRANT, thisComputerNotReady, thisComputerNotReadyError } from "./desktop-computer.ts";
import { startFailureText } from "./start-failure-text.ts";
import { userErrorFields, userErrorThrown, type UserErrorKey } from "./user-errors.ts";

const pairs: Array<[UserErrorKey, string]> = [
  ["serverError.computer.desktopOnly", "chat.notice.computerDesktopOnly"],
  ["serverError.computer.permissionsThenRestart", "chat.notice.computerPermissionsThenRestart"],
  ["serverError.computer.notReadyDetail", "chat.notice.computerNotReadyDetail"],
  ["serverError.computer.notReadyMacPermission", "chat.notice.computerNotReadyMacPermission"],
  ["serverError.computer.systemUnsupported", "chat.notice.computerSystemUnsupported"],
  ["serverError.computer.aiUnsupported", "chat.notice.computerAiUnsupported"],
  ["serverError.engine.signedOut", "chat.notice.engineSignedOut"],
];

describe("coded start failures", () => {
  it.each(pairs)("carries %s to its notice without recognizing a message", (errorKey, noticeKey) => {
    const error = userErrorThrown(errorKey, { name: "Fixture AI", reason: "Fixture permission" });
    const words = startFailureText(error)!;
    expect(words.key).toBe(noticeKey);
    expect(words.params).toEqual(userErrorFields(error).errorParams);
    expect(chatNotice(noticeKey as Parameters<typeof chatNotice>[0], words.params)).toBe(error.message);
    expect(startFailureText(new Error(error.message))).toBeUndefined();
  });

  it.each([null, undefined, new Error("vendor failure"), userErrorThrown("serverError.secret.missing")])("does not classify a different failure: %s", (error) => {
    expect(startFailureText(error)).toBeUndefined();
  });

  it("keeps the uncoded diagnostic's exact English for each desktop grant state", () => {
    const desktop = createDesktopComputer({ platform: "darwin" });
    const check = (key: UserErrorKey) => {
      const error = thisComputerNotReadyError(desktop, "darwin");
      expect(error.message).toBe(thisComputerNotReady(desktop, "darwin"));
      expect(userErrorFields(error).errorKey).toBe(key);
    };
    check("serverError.computer.desktopOnly");
    desktop.receive({ type: DESKTOP_COMPUTER_GRANT, connection: null });
    check("serverError.computer.permissionsThenRestart");
    for (const [reason, key] of [["Fixture driver unavailable", "serverError.computer.notReadyDetail"], ["Screen Recording required", "serverError.computer.notReadyMacPermission"]] as const) {
      desktop.receive({ type: DESKTOP_COMPUTER_GRANT, connection: { mode: "unavailable", reason } });
      check(key);
    }
  });
});
