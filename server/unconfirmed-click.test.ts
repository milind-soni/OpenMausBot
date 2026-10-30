import { describe, expect, it } from "vitest";
import { CLICK_SENT_UNCONFIRMED, unconfirmedClickResult } from "./unconfirmed-click.ts";

// cua-driver 0.28.2's own words (platform-windows/src/input/mouse.rs), with the conforming error envelope it adds.
const failed = (text: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text }], isError: true, structuredContent: { code: "tool_invocation_failed" }, ...extra });
const AFTER = "foreground_unavailable: exact target HWND 0x30a5c or a verified same-process post-action window was not foreground after the click (actual foreground HWND 0x1f00)";

describe("a Windows click whose after-check failed", () => {
  it("is answered as the sent, unconfirmed click it was, in the shape the driver gives a confirmed one", () => {
    expect(unconfirmedClickResult(failed(AFTER))).toEqual({
      content: [{ type: "text", text: CLICK_SENT_UNCONFIRMED }],
      structuredContent: { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } },
    });
    // A driver spoken to with per-request metadata keeps its protocol fields.
    const meta = { "io.modelcontextprotocol/serverInfo": { name: "cua-driver", version: "0.28.2" } };
    expect(unconfirmedClickResult(failed(AFTER, { resultType: "complete", _meta: meta }))).toMatchObject({ resultType: "complete", _meta: meta });
    expect(CLICK_SENT_UNCONFIRMED).not.toMatch(/HWND|foreground_unavailable/);
  });

  it("leaves every refusal from before the click alone: those sent nothing", () => {
    for (const before of [
      "foreground_unavailable: Windows did not activate exact target HWND 0x30a5c (actual foreground HWND 0x1f00); no mouse input was sent",
      "foreground_unavailable: exact target HWND 0x30a5c disappeared before mouse input could be sent",
      "foreground_unavailable: Windows did not confirm keyboard focus on exact UIA element [3] in HWND 0x30a5c; no keyboard input was sent",
      "SendInput inserted fewer modifier or mouse events than expected for the foreground click.",
    ]) expect(unconfirmedClickResult(failed(before))).toBeNull();
    expect(unconfirmedClickResult({ content: [{ type: "text", text: AFTER }] })).toBeNull();
    expect(unconfirmedClickResult(null)).toBeNull();
  });
});
