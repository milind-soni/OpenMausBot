import { describe, expect, it } from "vitest";

import { localComputerCallQuery, localComputerRelay, localComputerResultLine, OWN_PROFILE_UNAVAILABLE } from "./local-computer-guidance.ts";
import type { ChildCalls } from "./mcp-bridge.ts";
import { CLICK_SENT_UNCONFIRMED } from "./unconfirmed-click.ts";

// cua-driver 0.28.2's answer to browser_prepare {strategy:{kind:"existing_profile"}} from a standard-mode daemon, verbatim.
const EXISTING_PROFILE_REFUSAL = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: {
    content: [{ text: "refused (browser_consent_required): existing-profile attachment in standard mode requires --grant existing-profile or an embedding authorization host; bounded mode requires a matching manifest", type: "text" }],
    structuredContent: {
      refusal: {
        code: "browser_consent_required",
        detail: { authorization_host: null, authorization_required: true, permission_mode: "standard" },
        message: "existing-profile attachment in standard mode requires --grant existing-profile or an embedding authorization host; bounded mode requires a matching manifest",
      },
      status: "refused",
    },
  },
});

describe("localComputerResultLine", () => {
  it("tells the bot what to do instead when the driver refuses to attach to the person's signed-in profile", () => {
    const original = JSON.parse(EXISTING_PROFILE_REFUSAL);
    const rewritten = JSON.parse(localComputerResultLine(EXISTING_PROFILE_REFUSAL));

    expect(rewritten.result.content).toEqual([...original.result.content, { type: "text", text: OWN_PROFILE_UNAVAILABLE }]);
    expect(rewritten.result.structuredContent).toEqual(original.result.structuredContent);
    expect(rewritten.id).toBe(2);
  });

  it("names only routes the bot has, and rules out the one it cannot take", () => {
    expect(OWN_PROFILE_UNAVAILABLE).toMatch(/do not retry strategy existing_profile/u);
    for (const tool of ["select_computer", "fill_login", "launch_app", "get_window_state", "click", "type_text", "request_sign_in"]) {
      expect(OWN_PROFILE_UNAVAILABLE).toContain(tool);
    }
    expect(OWN_PROFILE_UNAVAILABLE).toContain("My Chrome");
    expect(OWN_PROFILE_UNAVAILABLE).not.toMatch(/--grant|authorization host/u);
  });

  it("puts the person's own screen last, and keeps the plumbing out of what the bot tells them", () => {
    const ownBrowser = OWN_PROFILE_UNAVAILABLE.indexOf("use your own browser");
    const cloud = OWN_PROFILE_UNAVAILABLE.indexOf("a cloud computer if select_computer offers one, or a connected app");
    const screen = OWN_PROFILE_UNAVAILABLE.indexOf("Only when the task needs the person's own signed-in session and nothing else works");
    expect(ownBrowser).toBeGreaterThan(-1);
    expect(cloud).toBeGreaterThan(ownBrowser);
    expect(screen).toBeGreaterThan(cloud);
    expect(OWN_PROFILE_UNAVAILABLE).toContain("never mention DevTools, CDP, debugging ports, profiles, grants, binding, attaching, endpoints or drivers");
  });

  it("sends the gate what a screen call would open, so the person is asked about that", () => {
    const frame = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "launch_app", arguments: { bundle_id: "com.google.Chrome", urls: ["https://calendar.google.com/"] } } };
    expect(localComputerCallQuery(frame)).toEqual({ app: "Chrome", site: "calendar.google.com" });
    expect(localComputerCallQuery({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "screenshot", arguments: {} } })).toEqual({});
  });

  it("passes every other frame through byte for byte", () => {
    const otherRefusal = EXISTING_PROFILE_REFUSAL
      .replaceAll("browser_consent_required", "browser_requires_setup")
      .replaceAll("existing-profile attachment", "this browser");
    for (const line of [
      otherRefusal,
      JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "prepared" }], structuredContent: { status: "ok" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_prepare", arguments: { strategy: { kind: "existing_profile" } } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, error: { code: -32603, message: "browser_consent_required" } }),
      "not json browser_consent_required",
    ]) {
      expect(localComputerResultLine(line)).toBe(line);
    }
  });
});

describe("localComputerRelay", () => {
  const child = (answer: (name: string, args: Record<string, unknown>) => Record<string, unknown>, driverVersion = "0.28.2") => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const relayed: ChildCalls = { driverVersion, call: async (name, args) => { calls.push([name, args]); return answer(name, args); } };
    return { calls, relayed };
  };
  const typing = { name: "type_text", arguments: { pid: 4242, window_id: 7, delivery_mode: "foreground", text: "hi" } };
  const after = "foreground_unavailable: exact target HWND 0x7 or a verified same-process post-action window was not foreground after the click (actual foreground HWND 0x9)";
  const front = { content: [{ type: "text", text: "front" }], structuredContent: { previous_fg_hwnd: "0x7", target_hwnd: "0x7" } };
  const typed = { content: [{ type: "text", text: "typed" }], structuredContent: { effect: "unverifiable", route: "global_input" } };

  it("leaves macOS and Linux calls to the driver as they came", () => {
    for (const platform of ["darwin", "linux"]) {
      const { relayed } = child(() => ({}));
      expect(localComputerRelay(platform)(typing, relayed)).toBeNull();
      expect(localComputerRelay(platform)({ name: "click", arguments: { pid: 1, x: 1, y: 1 } }, relayed)).toBeNull();
    }
  });

  it("on Windows types foreground text one character at a time on a driver that sends it in one burst", async () => {
    const { calls, relayed } = child((name) => (name === "bring_to_front" ? front : typed));
    const answer = await localComputerRelay("win32")(typing, relayed);
    expect(calls.filter(([name]) => name === "type_text").map(([, args]) => args.text)).toEqual(["h", "i"]);
    expect(answer).toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/^✅ Typed 2 char\(s\) on pid 4242 .*one character at a time\.$/) }] });
    expect(localComputerRelay("win32")(typing, child(() => typed, "0.35.0").relayed)).toBeNull();
    expect(localComputerRelay("win32")({ name: "type_text", arguments: { pid: 4242, window_id: 7, text: "hi" } }, relayed)).toBeNull();
  });

  it("on Windows answers a sent click whose after-check failed as the click it was, and every other answer as it is", async () => {
    for (const name of ["click", "double_click", "right_click"]) {
      const { calls, relayed } = child(() => ({ content: [{ type: "text", text: after }], isError: true }));
      const answer = await localComputerRelay("win32")({ name, arguments: { pid: 4242, window_id: 7, x: 10, y: 20, delivery_mode: "foreground" } }, relayed);
      expect(calls).toEqual([[name, { pid: 4242, window_id: 7, x: 10, y: 20, delivery_mode: "foreground" }]]);
      expect(answer).toMatchObject({ content: [{ type: "text", text: CLICK_SENT_UNCONFIRMED }] });
    }
    const refused = { content: [{ type: "text", text: "foreground_unavailable: … no mouse input was sent" }], isError: true };
    expect(await localComputerRelay("win32")({ name: "click", arguments: {} }, child(() => refused).relayed)).toBe(refused);
    expect(localComputerRelay("win32")({ name: "get_window_state", arguments: {} }, child(() => ({})).relayed)).toBeNull();
  });
});
