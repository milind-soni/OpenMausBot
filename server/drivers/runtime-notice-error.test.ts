import { describe, expect, it } from "vitest";
import { chatNotice } from "../chat-notices.ts";
import { codexActionFailure } from "./codex-action-notice.ts";
import { piModelId } from "./pi-model-id.ts";
import { RuntimeNoticeError, runtimeErrorText } from "./runtime-notice-error.ts";
import { acpRuntimeFailure } from "./acp/failure-words.ts";
import { engineFailure } from "./engine-errors.ts";
import { describeQuiet, quietNoticeText, quietVerdict } from "./acp/quiet-status.ts";

describe("runtime notice provenance", () => {
  it("retains engine classifications and app-owned codes at the ACP runtime boundary", () => {
    const message = "maximum 128 tools";
    expect(acpRuntimeFailure(new Error(message), "Grok")).toEqual(engineFailure("Grok", message));
    const error = new RuntimeNoticeError("Pi did not confirm the selected model", "chat.notice.piModelNotConfirmed");
    expect(acpRuntimeFailure(error, "Pi")).toEqual({ message: error.message, text: error.text });
    const account = { message: "Account refused", text: { key: "chat.notice.copilotAccountRefused" } };
    expect(acpRuntimeFailure(new Error(message), "Grok", account)).toEqual(account);
    expect(acpRuntimeFailure(new Error("Provider's own words"), "Grok", { text: account.text })).toEqual({ message: "Provider's own words", text: account.text });
    expect(acpRuntimeFailure(new Error(message), "Grok", {})).toEqual(engineFailure("Grok", message));
    const limited = quietVerdict({ name: "Custom ACP", next: { kind: "provider-error", message: "HTTP 429" }, logged: { signal: { kind: "provider-error", message: "HTTP 429" }, at: 0 }, now: 600_000, quietMs: 600_000, noSignsSince: null, stuckAfterMs: 600_000 }).stop!;
    expect(acpRuntimeFailure(limited, "Custom ACP")).toEqual({ ...engineFailure("Custom ACP", limited.message), text: runtimeErrorText(limited) });
  });

  it("keeps only an app-owned error's code and redacts its params centrally", () => {
    const secret = `sk-ant-${"Ab1c".repeat(9)}`;
    const error = new RuntimeNoticeError("Pi did not confirm the selected model", "chat.notice.piModelNotConfirmed", { detail: secret });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Pi did not confirm the selected model");
    expect(runtimeErrorText(error)?.key).toBe("chat.notice.piModelNotConfirmed");
    expect(JSON.stringify(runtimeErrorText(error))).not.toContain(secret);
    expect(runtimeErrorText(new Error(error.message))).toBeUndefined();
    expect(runtimeErrorText({ text: error.text })).toBeUndefined();
  });

  it.each([false, true])("codes the tool-action suffix only when an action may have run (%s)", (mayHaveRun) => {
    const failure = codexActionFailure("Provider's own words", mayHaveRun);
    expect(failure.message).toBe(`Provider's own words${mayHaveRun ? " A tool action may have run. Check its effects before trying again." : ""}`);
    expect("text" in failure ? failure.text?.key : undefined).toBe(mayHaveRun ? "chat.notice.codexActionMayHaveRun" : undefined);
  });

  it("keeps a coded Codex failure when no tool action may have run", () => {
    const text = { key: "chat.notice.codexModelUnavailable" };
    expect(codexActionFailure("Model unavailable", false, text)).toEqual({ message: "Model unavailable", text });
    expect(codexActionFailure("Model unavailable", true, text).text?.key).toBe("chat.notice.codexActionMayHaveRun");
  });

  it.each([1_000, 89_000, 90_000, 180_000])("keeps the provider error's quiet duration at %i ms", (quietMs) => {
    const state = { kind: "provider-error", message: "Provider's own words" } as const;
    const words = quietNoticeText("Custom ACP", state, quietMs)!;
    expect(chatNotice("chat.notice.acpModelRequestFailed", words.params)).toBe(describeQuiet("Custom ACP", state, quietMs, 600_000));
    expect(quietNoticeText("Custom ACP", { kind: "unknown" }, quietMs)).toBeUndefined();
  });

  it("carries the quiet-stop classifications and their complete English sentences", () => {
    const verdict = quietVerdict({ name: "Custom ACP", next: { kind: "provider-error", message: "HTTP 429" }, logged: { signal: { kind: "provider-error", message: "HTTP 429" }, at: 0 }, now: 600_000, quietMs: 600_000, noSignsSince: null, stuckAfterMs: 600_000 });
    expect(verdict.stop).toMatchObject({ acpUsageLimit: true });
    const text = runtimeErrorText(verdict.stop)!;
    expect(text.key).toBe("chat.notice.acpQuietUsageLimit");
    expect(chatNotice("chat.notice.acpQuietUsageLimit", text.params)).toBe(verdict.stop?.message);
    const stuck = quietVerdict({ name: "Custom ACP", next: { kind: "no-signs" }, logged: null, now: 600_000, quietMs: 600_000, noSignsSince: 0, stuckAfterMs: 100_000 });
    expect(stuck.stop).toMatchObject({ acpPromptStall: true });
    expect(runtimeErrorText(stuck.stop)?.key).toBe("chat.notice.acpQuietStuck");
  });

  it.each([null, undefined, {}, { provider: "x" }, { id: "y" }, { provider: 1, id: "y" }, { provider: "", id: "y" }])("does not confirm a partial Pi model: %j", (model) => {
    expect(piModelId(model)).toBeNull();
  });

  it("keeps Pi's confirmed provider and model id verbatim", () => {
    expect(piModelId({ provider: "FixtureProvider", id: "CaseSensitiveModel", name: "Fixture" })).toBe("FixtureProvider/CaseSensitiveModel");
  });
});
