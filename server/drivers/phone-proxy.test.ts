import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PHONE_STEP_TOOLS } from "../../shared/phone-steps.ts";
import { TOOLS, createPhoneClaim, findPackages, launchTarget, parseDevices, parseLaunchablePackages, parseSteps, parseUiNodes, runSteps, typePhoneText, type PhoneStep } from "./phone-proxy.ts";

describe("phone MCP parsing", () => {
  it("keeps physical USB devices distinguishable from network and emulator transports", () => {
    expect(parseDevices(`List of devices attached
USB123 device product:husky model:Pixel_8 usb:1-2 transport_id:4
emulator-5554 device product:sdk model:Emulator transport_id:6
192.0.2.4:5555 device product:remote model:Remote transport_id:7
`)).toEqual([
      { serial: "USB123", state: "device", connection: "usb", model: "Pixel 8" },
      { serial: "emulator-5554", state: "device", connection: "emulator", model: "Emulator" },
      { serial: "192.0.2.4:5555", state: "device", connection: "network", model: "Remote" },
    ]);
  });

  it("extracts unique launchable packages", () => {
    expect(parseLaunchablePackages(`2 activities found:
      com.ubercab/.presidio.RootActivity
      net.skyscanner.android.main/net.skyscanner.shell.SplashActivity
      com.ubercab/.presidio.RootActivity
    `)).toEqual(["com.ubercab", "net.skyscanner.android.main"]);
  });

  it("resolves common human app names before using package-name heuristics", () => {
    const packages = ["com.ubercab", "net.skyscanner.android.main", "com.example.other"];
    expect(findPackages("Uber", packages)).toEqual(["com.ubercab"]);
    expect(findPackages("Skyscanner", packages)).toEqual(["net.skyscanner.android.main"]);
  });

  it("tells the bot to pass a package name when no app name matches", () => {
    const packages = ["com.taobao.idlefish", "com.ubercab"];
    expect(() => launchTarget("闲鱼", packages)).toThrow("call list_apps without a query and pass the package name");
    expect(launchTarget("com.taobao.idlefish", packages)).toBe("com.taobao.idlefish");
  });

  it("keeps naming the candidates when an app name is ambiguous", () => {
    expect(() => launchTarget("taobao", ["com.taobao.idlefish", "com.taobao.taobao"])).toThrow("App name is ambiguous: com.taobao.idlefish, com.taobao.taobao");
  });

  it("offers keys that turn the screen on and off", () => {
    const press = TOOLS.find((tool) => tool.name === "press") as { inputSchema: { properties: { key: { enum: string[] } } } } | undefined;
    expect(press?.inputSchema.properties.key.enum).toEqual(expect.arrayContaining(["wakeup", "sleep"]));
  });

  it("turns Android UI XML into tap-ready visible nodes", () => {
    expect(parseUiNodes(`<?xml version="1.0"?><hierarchy><node text="Where to?" resource-id="com.ubercab:id/input" class="android.widget.TextView" content-desc="Destination" bounds="[12,100][400,180]" /></hierarchy>`)).toEqual([
      { text: "Where to?", description: "Destination", id: "com.ubercab:id/input", className: "android.widget.TextView", bounds: [12, 100, 400, 180] },
    ]);
  });
});

describe("phone MCP text input", () => {
  const ADB_KEYBOARD = "com.android.adbkeyboard/.AdbIME";
  const VENDOR_KEYBOARD = "com.baidu.input_huawei/.ImeService";
  const SENT = "Sent the text to ADBKeyBoard. Use read_screen to check that it reached the field.";
  const device = (keyboard: string) => {
    const commands: string[][] = [];
    const shell = async (...command: string[]) => {
      commands.push(command);
      return command[0] === "settings" ? `${keyboard}\n` : "";
    };
    return { commands, shell };
  };

  it.each([ADB_KEYBOARD, VENDOR_KEYBOARD])("types basic ASCII with Android input whatever the keyboard (%s)", async (keyboard) => {
    const phone = device(keyboard);
    await expect(typePhoneText(phone.shell, "iPad mini_6")).resolves.toBe("Typed text into the focused Android field");
    expect(phone.commands).toEqual([["input", "text", "iPad%smini_6"]]);
  });

  it("types any other text through ADBKeyBoard as Base64 UTF-8", async () => {
    const phone = device(ADB_KEYBOARD);
    await expect(typePhoneText(phone.shell, "二手 iPad +86 😀")).resolves.toBe(SENT);
    expect(phone.commands).toEqual([
      ["settings", "get", "secure", "default_input_method"],
      ["am", "broadcast", "-a", "ADB_INPUT_B64", "-p", "com.android.adbkeyboard", "--es", "msg", "5LqM5omLIGlQYWQgKzg2IPCfmIA="],
    ]);
  });

  it.each(["二".repeat(256), "😀".repeat(256)])("types up to 256 characters of other text, counting each emoji once", async (text) => {
    const phone = device(ADB_KEYBOARD);
    await expect(typePhoneText(phone.shell, text)).resolves.toBe(SENT);
    expect(phone.commands.map((command) => command[0])).toEqual(["settings", "am"]);
  });

  it.each(["iPad", "二手"])("reports a failed adb command instead of claiming it typed (%s)", async (text) => {
    const shell = async (...command: string[]) => {
      if (command[0] === "settings") return `${ADB_KEYBOARD}\n`;
      throw new Error("error: closed");
    };
    await expect(typePhoneText(shell, text)).rejects.toThrow("error: closed");
  });

  it("asks for ADBKeyBoard and types nothing when another keyboard is chosen", async () => {
    const phone = device(VENDOR_KEYBOARD);
    await expect(typePhoneText(phone.shell, "二手 iPad")).rejects.toThrow("ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and chosen as the phone's keyboard");
    expect(phone.commands).toEqual([["settings", "get", "secure", "default_input_method"]]);
  });

  it.each(["", "a".repeat(257), "😀".repeat(257)])("refuses empty or over-long text without touching the phone", async (text) => {
    const phone = device(ADB_KEYBOARD);
    await expect(typePhoneText(phone.shell, text)).rejects.toThrow("Android text must be 1 to 256 characters");
    expect(phone.commands).toEqual([]);
  });
});

describe("phone MCP lazy claim gate", () => {
  const harnessEnv = { OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_PHONE_TOKEN: "tok" };
  const stub = (handler: (request: Request) => Promise<{ ok: boolean; status: number }>) => {
    const calls: Request[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      calls.push(request);
      return handler(request);
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("proceeds without a harness when the proxy runs standalone", async () => {
    const { calls, fetchImpl } = stub(async () => ({ ok: true, status: 200 }));
    const ensure = createPhoneClaim({}, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("claims lazily and revalidates ownership on every call", async () => {
    const { calls, fetchImpl } = stub(async () => ({ ok: true, status: 200 }));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    expect(calls).toHaveLength(0);
    await expect(ensure()).resolves.toEqual({ ok: true });
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok");
  });

  it.each([401, 403, 409])("rejects a previously successful caller after ownership is lost (%s)", async (status) => {
    let active = true;
    const { calls, fetchImpl } = stub(async () => active ? { ok: true, status: 200 } : { ok: false, status });
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: true });
    active = false;
    await expect(ensure()).resolves.toMatchObject({ ok: false });
    expect(calls).toHaveLength(2);
  });

  it("returns the blocked text on conflict and retries on a later call", async () => {
    let busy = true;
    const { calls, fetchImpl } = stub(async () => (busy ? { ok: false, status: 409 } : { ok: true, status: 200 }));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    const first = await ensure();
    expect(first).toEqual({ ok: false, message: "Another thread is using the phone. This call was not performed. Pause phone work until that thread finishes, then read the screen again before acting." });
    busy = false;
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("names the ended turn when the capability is gone and stays honest on transport failure", async () => {
    let reject = false;
    const { fetchImpl } = stub(async () => (reject
      ? Promise.reject(new Error("fetch failed"))
      : Promise.resolve({ ok: false, status: 401 })));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: false, message: "This turn no longer has phone access. Start a new turn to use the phone." });
    reject = true;
    await expect(ensure()).resolves.toMatchObject({ ok: false, message: expect.stringContaining("could not be reached") });
  });
});

const SCREEN = '0: "Search" bounds=0,100,200,180 class=android.widget.TextView';
const EARLIER_AND_LATER = "Steps before it were done; do not repeat them. Later steps were not performed.";

describe("phone batch step parsing", () => {
  it.each([
    { case: "coerces named fields", raw: [{ action: "Tap", x: "540", y: 1200 }], steps: [{ action: "tap", x: 540, y: 1200 }] },
    { case: "keeps a numeric code a string", raw: [{ action: "type_text", text: "10001" }, { action: "type_text", text: 10001 }], steps: [{ action: "type_text", text: "10001" }, { action: "type_text", text: "10001" }] },
    { case: "coerces a match index and exact", raw: [{ action: "tap_text", text: "Search", index: "1", exact: "true" }, { action: "tap_text", text: "Search", exact: "false" }], steps: [{ action: "tap_text", text: "Search", index: 1, exact: true }, { action: "tap_text", text: "Search", exact: false }] },
    { case: "treats null and empty fields as absent", raw: [{ action: "tap_text", text: "Search", index: null, exact: "", seconds: null }, { action: "wait", seconds: "" }], steps: [{ action: "tap_text", text: "Search" }, { action: "wait" }] },
    { case: "lowercases action, key and direction", raw: [{ action: "PRESS", key: "Enter" }, { action: "swipe", direction: "UP" }], steps: [{ action: "press", key: "enter" }, { action: "swipe", direction: "up" }] },
    { case: "ignores fields no action takes", raw: [{ action: "read_screen", verify: true, serial: "X" }, { action: "open_app", name: "Settings", why: "check" }], steps: [{ action: "read_screen" }, { action: "open_app", name: "Settings" }] },
    { case: "parses steps given as JSON text", raw: '[{"action":"read_screen"}]', steps: [{ action: "read_screen" }] },
    { case: "parses a step given as JSON text", raw: ['{"action":"press","key":"back"}'], steps: [{ action: "press", key: "back" }] },
    { case: "accepts waits from 0 and above 60", raw: [{ action: "wait" }, { action: "wait", seconds: 0 }, { action: "wait", seconds: "75" }], steps: [{ action: "wait" }, { action: "wait", seconds: 0 }, { action: "wait", seconds: 75 }] },
    { case: "accepts 10 steps", raw: Array(10).fill({ action: "read_screen" }), steps: Array(10).fill({ action: "read_screen" }) },
    { case: "coerces both coordinates", raw: [{ action: "tap", x: "540", y: "1200" }], steps: [{ action: "tap", x: 540, y: 1200 }] },
    { case: "counts text to type in characters, as type_text does", raw: [{ action: "type_text", text: "😀".repeat(256) }], steps: [{ action: "type_text", text: "😀".repeat(256) }] },
  ])("$case", ({ raw, steps }) => {
    expect(parseSteps(raw)).toEqual(steps);
  });

  it.each([
    { case: "a wait field on another action", raw: [{ action: "tap", x: 1, y: 2, seconds: 5 }], error: 'Step 1 (tap) does not take seconds; put a separate {"action":"wait","seconds":5} step after it. No step was performed.' },
    { case: "a field of another action", raw: [{ action: "tap", x: 1, y: 2, text: "Go" }], error: 'Step 1 (tap) does not take text, which belongs to tap_text or type_text; write it like {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "missing fields", raw: [{ action: "tap" }], error: 'Step 1 (tap) needs x and y, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a missing field in a later step", raw: [{ action: "read_screen" }, { action: "type_text", text: "" }], error: 'Step 2 (type_text) needs text, e.g. {"action":"type_text","text":"iPad mini"}. No step was performed.' },
    { case: "a screenshot step", raw: [{ action: "screenshot" }], error: "Step 1: screenshot returns an image and cannot be a batch step; use read_screen, or call screenshot after the batch. No step was performed." },
    { case: "a batch step", raw: [{ action: "batch", steps: [{ action: "read_screen" }] }], error: "Step 1: a batch cannot be a batch step; put its steps in this list. No step was performed." },
    { case: "an action that is not a step", raw: [{ action: "status" }], error: 'Step 1 needs an action from open_app, tap_text, tap, swipe, type_text, press, read_screen, wait, e.g. {"action":"tap_text","text":"Search"}. No step was performed.' },
    { case: "a wait that is not a number", raw: [{ action: "wait", seconds: "x" }], error: 'Step 1 (wait) needs seconds as a number from 0 to 60, e.g. {"action":"wait","seconds":3}. No step was performed.' },
    { case: "coordinates off the screen", raw: [{ action: "tap", x: -1, y: 2 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a fractional match index", raw: [{ action: "tap_text", text: "Search", index: "1.5" }], error: 'Step 1 (tap_text) needs index as a whole number from 0, e.g. {"action":"tap_text","text":"Search","index":1}. No step was performed.' },
    { case: "an exact that is not true or false", raw: [{ action: "tap_text", text: "Search", exact: "yes" }], error: 'Step 1 (tap_text) needs exact as true or false, e.g. {"action":"tap_text","text":"Search","exact":true}. No step was performed.' },
    { case: "blank text to tap", raw: [{ action: "tap_text", text: "  " }], error: 'Step 1 (tap_text) needs text that is not blank, e.g. {"action":"tap_text","text":"Search"}. No step was performed.' },
    { case: "a blank app name", raw: [{ action: "open_app", name: " " }], error: `Step 1 (open_app) needs name, an app's English name or package name, e.g. {"action":"open_app","name":"Settings"}. No step was performed.` },
    { case: "text too long to type", raw: [{ action: "type_text", text: "a".repeat(257) }], error: 'Step 1 (type_text) needs text of at most 256 characters, e.g. {"action":"type_text","text":"iPad mini"}. No step was performed.' },
    { case: "an unknown swipe direction", raw: [{ action: "swipe", direction: "north" }], error: 'Step 1 (swipe) needs direction as one of up, down, left, right, e.g. {"action":"swipe","direction":"up"}. No step was performed.' },
    { case: "an unknown key", raw: [{ action: "press", key: "f13" }], error: 'Step 1 (press) needs key as one of back, delete, down, enter, escape, home, left, recent, return, right, sleep, space, tab, up, wakeup, e.g. {"action":"press","key":"enter"}. No step was performed.' },
    { case: "a step that is not an object", raw: ["read_screen"], error: 'Step 1 needs to be an object such as {"action":"tap_text","text":"Search"}. No step was performed.' },
    { case: "11 steps", raw: Array(11).fill({ action: "read_screen" }), error: "A batch runs at most 10 steps, not 11; split them into several batches. No step was performed." },
    { case: "no steps", raw: undefined, error: 'steps needs a list of 1 to 10 steps, e.g. {"steps":[{"action":"tap_text","text":"Search"},{"action":"read_screen"}]}. No step was performed.' },
    { case: "an empty step list", raw: [], error: 'steps needs a list of 1 to 10 steps, e.g. {"steps":[{"action":"tap_text","text":"Search"},{"action":"read_screen"}]}. No step was performed.' },
    { case: "text that is empty once read as text, after a valid step", raw: [{ action: "tap", x: 540, y: 1200 }, { action: "type_text", text: [] }], error: 'Step 2 (type_text) needs text, e.g. {"action":"type_text","text":"iPad mini"}. No step was performed.' },
    { case: "a negative match index", raw: [{ action: "tap_text", text: "Search", index: -1 }], error: 'Step 1 (tap_text) needs index as a whole number from 0, e.g. {"action":"tap_text","text":"Search","index":1}. No step was performed.' },
    { case: "a y off the screen", raw: [{ action: "tap", x: 1, y: -1 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "an x past 10000", raw: [{ action: "tap", x: 10001, y: 2 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a coordinate that is not a number", raw: [{ action: "tap", x: [], y: 1200 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a blank coordinate string", raw: [{ action: "tap", x: " ", y: 1200 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a negative wait", raw: [{ action: "wait", seconds: -1 }], error: 'Step 1 (wait) needs seconds as a number from 0 to 60, e.g. {"action":"wait","seconds":3}. No step was performed.' },
    { case: "a negative wait on another action", raw: [{ action: "tap", x: 1, y: 2, seconds: -1 }], error: 'Step 1 (tap) does not take seconds; put a separate {"action":"wait","seconds":3} step after it. No step was performed.' },
  ])("refuses $case", ({ raw, error }) => {
    expect(() => parseSteps(raw)).toThrow(new Error(error));
  });
});

describe("phone batch runs", () => {
  const OUTPUT: Record<string, string> = { tap: "Tapped 540,1200", tap_text: 'Tapped "Search"', press: "Pressed enter", read_screen: SCREEN };
  const TAP: PhoneStep = { action: "tap", x: 540, y: 1200 };
  const TAP_TEXT: PhoneStep = { action: "tap_text", text: "Search" };
  const PRESS: PhoneStep = { action: "press", key: "enter" };
  const READ: PhoneStep = { action: "read_screen" };
  const run = async (steps: PhoneStep[], failAt = 0, refuseBefore = 0, refusal = "This turn no longer has phone access. Start a new turn to use the phone.") => {
    const performed: string[] = [];
    let claims = 0;
    const result = await runSteps("FAKE123", steps, async () => {
      claims += 1;
      return claims + 1 === refuseBefore ? { ok: false, message: refusal } : { ok: true };
    }, async (serial, step) => {
      performed.push(`${serial} ${step.action}`);
      if (performed.length === failAt) throw new Error('No visible Android text matches "Buy"');
      return OUTPUT[step.action];
    });
    return { performed, claims, text: (result.content[0] as { text: string }).text, isError: result.isError };
  };

  it.each([
    { case: "acts without reading the screen when no step asks", steps: [TAP], performed: ["FAKE123 tap"], claims: 0, text: "1. tap: Tapped 540,1200" },
    { case: "shows the screen under a read_screen step", steps: [TAP, READ], performed: ["FAKE123 tap", "FAKE123 read_screen"], claims: 1, text: `1. tap: Tapped 540,1200\n2. read_screen:\n${SCREEN}` },
    { case: "stops at a failing step 2 without an error flag", steps: [TAP_TEXT, TAP_TEXT, READ], failAt: 2, performed: ["FAKE123 tap_text", "FAKE123 tap_text"], claims: 1, text: `1. tap_text: Tapped "Search"\nStep 2 failed: No visible Android text matches "Buy". Its effect is unknown; call read_screen or screenshot before trying it again. ${EARLIER_AND_LATER}` },
    { case: "flags an error when step 1 fails", steps: [TAP_TEXT, READ], failAt: 1, performed: ["FAKE123 tap_text"], claims: 0, text: `Step 1 failed: No visible Android text matches "Buy". Its effect is unknown; call read_screen or screenshot before trying it again. ${EARLIER_AND_LATER}`, isError: true },
    { case: "stops when the claim is refused before step 2", steps: [TAP, PRESS, READ], refuseBefore: 2, performed: ["FAKE123 tap"], claims: 1, text: `1. tap: Tapped 540,1200\nStopped before step 2: This turn no longer has phone access. Start a new turn to use the phone. ${EARLIER_AND_LATER}` },
    { case: "rechecks the claim before every later step", steps: [TAP, PRESS, READ], refuseBefore: 3, performed: ["FAKE123 tap", "FAKE123 press"], claims: 2, text: `1. tap: Tapped 540,1200\n2. press: Pressed enter\nStopped before step 3: This turn no longer has phone access. Start a new turn to use the phone. ${EARLIER_AND_LATER}` },
  ])("$case", async ({ steps, failAt, refuseBefore, performed, claims, text, isError }) => {
    expect(await run(steps, failAt, refuseBefore)).toEqual({ performed, claims, text, isError });
  });

  it.each([
    { refusal: "Another thread is using the phone. This call was not performed. Pause phone work until that thread finishes, then read the screen again before acting.", said: "Another thread is using the phone. Pause phone work until that thread finishes, then read the screen again before acting" },
    { refusal: "OpenMausBot could not be reached to reserve the phone. This call was not performed; try again.", said: "OpenMausBot could not be reached to reserve the phone" },
  ])("does not call a half-done batch unperformed when the claim is refused: $said", async ({ refusal, said }) => {
    const { text } = await run([TAP, PRESS], 0, 2, refusal);
    expect(text).toBe(`1. tap: Tapped 540,1200\nStopped before step 2: ${said}. ${EARLIER_AND_LATER}`);
  });

  it("waits 2 s by default, and at most 60 s", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const result = runSteps("FAKE123", [{ action: "wait" }, { action: "wait", seconds: 75 }], async () => ({ ok: true }));
      void result.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(61_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect((await result).content).toEqual([{ type: "text", text: "1. wait: Waited 2 s\n2. wait: Waited 60 s (a wait is at most 60 s)" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("phone MCP tool surface", () => {
  type Property = { enum?: string[]; description?: string };
  const tool = (name: string) => TOOLS.find((candidate) => candidate.name === name) as unknown as {
    description: string;
    inputSchema: { properties: Record<string, Property> & { steps: { maxItems: number; items: { properties: Record<string, Property> } } } };
  };

  it("keeps every schema flat", () => {
    expect(JSON.stringify({ tools: TOOLS })).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
  });

  it("offers the shared step tools and wait as steps, each field naming its action", () => {
    const steps = tool("batch").inputSchema.properties.steps;
    expect(steps.items.properties.action.enum).toEqual([...PHONE_STEP_TOOLS, "wait"]);
    expect(steps.maxItems).toBe(10);
    expect(tool("batch").inputSchema.properties.serial).toEqual({ type: "string" });
    for (const name of PHONE_STEP_TOOLS) {
      for (const field of Object.keys(tool(name).inputSchema.properties).filter((key) => key !== "serial")) {
        expect(steps.items.properties[field]?.description?.split(": ")[0].split(" and "), `${name}.${field}`).toContain(name);
      }
    }
    expect(steps.items.properties.seconds.description).toBe("wait: how long to wait, 0 to 60, default 2.");
    expect(steps.items.properties.index.description).toBe("tap_text: which match of the text, from 0.");
  });

  it("describes batch as designed", () => {
    expect(tool("batch").description).toBe('Run up to 10 phone steps in order in one call. A step is one of open_app, tap_text, tap, swipe, type_text, press, read_screen or wait, with that tool\'s fields: {action, ...fields}. Add read_screen as the last step to see the result; the batch returns the screen only at a read_screen step. A wait step (0 to 60 s) gives content time to load. It stops at the first failing step. Example: {"steps":[{"action":"tap_text","text":"Search"},{"action":"type_text","text":"iPad mini"},{"action":"press","key":"enter"},{"action":"wait","seconds":3},{"action":"read_screen"}]}');
  });

  it("points read_screen and the actions at batch", () => {
    expect(tool("read_screen").description).toBe("Read visible text, accessibility labels, resource ids, and pixel bounds from the connected Android screen. Use it before choosing what to act on. To act and see the result in one call, put the action and read_screen in one batch.");
    for (const name of ["open_app", "tap_text", "tap", "swipe", "type_text", "press"]) {
      expect(tool(name).description).toMatch(/\. To do several steps, or to act and then read the screen, in one call, use batch\.$/);
      expect(tool(name).description).not.toContain("then use read_screen to verify");
    }
  });
});

describe.skipIf(process.platform === "win32")("phone MCP calls through a stand-in adb", () => {
  type Response = { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
  type Call = (name: string, args: Record<string, unknown>) => Promise<Response>;
  let home = "";
  let adb = "";
  const proxies: ChildProcess[] = [];
  let call: Call;
  const adbLog = () => (existsSync(join(home, "adb.log")) ? readFileSync(join(home, "adb.log"), "utf8").trim().split("\n") : []);
  const DUMP = "-s FAKE123 shell uiautomator dump /dev/tty";

  const startProxy = (harness: Record<string, string> = {}): Call => {
    const env: NodeJS.ProcessEnv = { ...process.env, OMB_ADB_PATH: adb };
    delete env.OMB_HARNESS_URL;
    delete env.OMB_PHONE_TOKEN;
    delete env.PH_ANDROID_SERIAL;
    const proxy = spawn(process.execPath, [fileURLToPath(new URL("./phone-proxy.ts", import.meta.url))], { env: { ...env, ...harness }, stdio: ["pipe", "pipe", "ignore"] });
    proxies.push(proxy);
    const waiting = new Map<number, (response: Response) => void>();
    createInterface({ input: proxy.stdout! }).on("line", (line) => {
      const response = JSON.parse(line) as Response & { id: number };
      waiting.get(response.id)?.(response);
    });
    let id = 0;
    return (name, args) => new Promise((resolve) => {
      waiting.set(++id, resolve);
      proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "omb-phone-proxy-"));
    adb = join(home, "adb");
    writeFileSync(adb, `#!/bin/sh
echo "$*" >> "$(dirname "$0")/adb.log"
case "$*" in
  "devices -l") printf 'List of devices attached\\nFAKE123 device usb:1-2 product:husky model:Pixel_8 transport_id:4\\n' ;;
  *"uiautomator dump /dev/tty") printf '%s' '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node text="Search" resource-id="" class="android.widget.TextView" content-desc="" bounds="[0,100][200,180]" /></hierarchy>' ;;
  *"cmd package query-activities"*) echo "com.ubercab/.presidio.RootActivity" ;;
  *"wm size") echo "Physical size: 1080x2400" ;;
esac
`);
    chmodSync(adb, 0o755);
    call = startProxy();
  });
  afterAll(() => {
    for (const proxy of proxies) proxy.kill();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { name: "read_screen", args: {}, text: SCREEN, adb: [DUMP] },
    { name: "open_app", args: { name: "Uber" }, text: "Opened Uber (com.ubercab)", adb: ["-s FAKE123 shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER", "-s FAKE123 shell monkey -p com.ubercab -c android.intent.category.LAUNCHER 1"] },
    { name: "tap_text", args: { text: "search" }, text: 'Tapped "Search"', adb: [DUMP, "-s FAKE123 shell input tap 100 140"] },
    { name: "tap", args: { x: 540, y: 1200 }, text: "Tapped 540,1200", adb: ["-s FAKE123 shell input tap 540 1200"] },
    { name: "swipe", args: { direction: "up" }, text: "Swiped up", adb: ["-s FAKE123 shell wm size", "-s FAKE123 shell input swipe 540 1800 540 600 260"] },
    { name: "type_text", args: { text: "iPad mini" }, text: "Typed text into the focused Android field", adb: ["-s FAKE123 shell input text iPad%smini"] },
    { name: "press", args: { key: "enter" }, text: "Pressed enter", adb: ["-s FAKE123 shell input keyevent KEYCODE_ENTER"] },
  ])("$name returns its single-call text", async ({ name, args, text, adb }) => {
    rmSync(join(home, "adb.log"), { force: true });
    expect((await call(name, args)).result).toEqual({ content: [{ type: "text", text }] });
    expect(adbLog()).toEqual(["devices -l", ...adb]);
  });

  it("runs a batch's steps in one call and returns the screen only at its read_screen step", async () => {
    rmSync(join(home, "adb.log"), { force: true });
    const response = await call("batch", { steps: [{ action: "tap_text", text: "Search" }, { action: "wait", seconds: 0 }, { action: "read_screen" }] });
    expect(response.result).toEqual({ content: [{ type: "text", text: `1. tap_text: Tapped "Search"\n2. wait: Waited 0 s\n3. read_screen:\n${SCREEN}` }] });
    expect(adbLog()).toEqual(["devices -l", DUMP, "-s FAKE123 shell input tap 100 140", DUMP]);
  });

  it("refuses an invalid batch before touching the phone", async () => {
    rmSync(join(home, "adb.log"), { force: true });
    const response = await call("batch", { steps: [{ action: "read_screen" }, { action: "tap" }] });
    expect(response.result).toEqual({ content: [{ type: "text", text: 'Step 2 (tap) needs x and y, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' }], isError: true });
    expect(adbLog()).toEqual([]);
  });

  it("keeps a single tool to its own action whatever action its arguments name", async () => {
    rmSync(join(home, "adb.log"), { force: true });
    expect((await call("tap", { x: 540, y: 1200, action: "press", key: "home" })).result).toEqual({ content: [{ type: "text", text: "Tapped 540,1200" }] });
    expect(adbLog()).toEqual(["devices -l", "-s FAKE123 shell input tap 540 1200"]);
  });

  it("runs a batch on the device its serial names", async () => {
    rmSync(join(home, "adb.log"), { force: true });
    const response = await call("batch", { serial: "MISSING", steps: [{ action: "tap", x: 540, y: 1200 }] });
    expect(response.result).toEqual({ content: [{ type: "text", text: "No physical USB Android device is connected" }], isError: true });
    expect(adbLog()).toEqual(["devices -l"]);
  });

  it("stops a batch at the next step once the harness refuses the claim", async () => {
    const answers = [200, 409];
    const harness = createServer((request, response) => {
      request.resume();
      response.writeHead(answers.shift() ?? 409).end("{}");
    });
    await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = harness.address() as AddressInfo;
      const claimed = startProxy({ OMB_HARNESS_URL: `http://127.0.0.1:${port}`, OMB_PHONE_TOKEN: "tok" });
      rmSync(join(home, "adb.log"), { force: true });
      const response = await claimed("batch", { steps: [{ action: "tap", x: 540, y: 1200 }, { action: "press", key: "enter" }] });
      expect(response.result).toEqual({ content: [{ type: "text", text: "1. tap: Tapped 540,1200\nStopped before step 2: Another thread is using the phone. Pause phone work until that thread finishes, then read the screen again before acting. Steps before it were done; do not repeat them. Later steps were not performed." }] });
      expect(adbLog()).toEqual(["devices -l", "-s FAKE123 shell input tap 540 1200"]);
    } finally {
      harness.close();
    }
  });
});
