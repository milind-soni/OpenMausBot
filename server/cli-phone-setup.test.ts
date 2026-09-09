import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliOptions } from "./cli.ts";
import { SetupCancelled, type SetupIo } from "./cli-prompts.ts";
import { normalizePhoneOrigin, phonePairingInstructions, runPhoneSetup, type PhoneSetupDependencies } from "./cli-phone-setup.ts";

const options: CliOptions = {
  command: "start", port: 18799, dataDir: "/fixture/phone-home", tailscale: false,
  tunnel: false, pair: false, client: false, json: false,
};

function prompts(script: { choices?: Array<number | Error>; confirms?: boolean[]; answers?: Array<string | Error> } = {}) {
  const choices = [...script.choices ?? []];
  const confirms = [...script.confirms ?? []];
  const answers = [...script.answers ?? []];
  const lines: string[] = [];
  const take = <T>(values: Array<T | Error>, question: string): T => {
    if (!values.length) throw new Error(`Unexpected fixture prompt: ${question}`);
    const next = values.shift()!;
    if (next instanceof Error) throw next;
    return next;
  };
  const io: SetupIo = {
    log: vi.fn((line: string) => { lines.push(line); }),
    choose: vi.fn(async (question: string, choicesOffered: readonly string[]) => {
      lines.push(question, ...choicesOffered);
      return take(choices, question);
    }),
    ask: vi.fn(async (question: string) => take(answers, question)),
    secret: vi.fn(async () => { throw new Error("The fixture must inject account sign-in"); }),
    confirm: vi.fn(async (question: string) => { lines.push(question); return take(confirms, question); }),
  };
  return { io, lines, consumed: () => expect([choices, confirms, answers]).toEqual([[], [], []]) };
}

function dependencies() {
  return {
    accountReady: vi.fn<NonNullable<PhoneSetupDependencies["accountReady"]>>().mockReturnValue(false),
    login: vi.fn<PhoneSetupDependencies["login"]>().mockResolvedValue(0),
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Phone setup fixtures must not use the network"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("phone origin validation", () => {
  it.each([
    ["https://maus.example", "https://maus.example"],
    ["  https://MAUS.example:443/  ", "https://maus.example"],
    ["https://mini.tail1234.ts.net:8443", "https://mini.tail1234.ts.net:8443"],
    ["https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443"],
  ])("normalizes an HTTPS origin without claiming reachability: %s", (input, expected) => {
    expect(normalizePhoneOrigin(input)).toBe(expected);
  });

  it.each([
    "", "not a url", "http://maus.example", "https:maus.example", "https:///maus.example", "https://@maus.example",
    "https://localhost", "https://localhost.",
    "https://mini.localhost", "https://127.0.0.1:8799", "https://127.1", "https://2130706433",
    "https://0.0.0.0", "https://[::]", "https://[::1]", "https://[::ffff:127.0.0.1]",
    "https://[::ffff:0.0.0.0]", "https://user:password@maus.example", "https://maus.example/pair",
    "https://maus.example/?token=secret", "https://maus.example/#code=ABCD-EFGH-JKLM",
    "https://maus.example/?", "https://maus.example/#", "https://maus.\nexample",
    "https://maus.example\\private", "openmausbot://pair?token=secret",
  ])("rejects a local, credential-bearing or non-origin input: %s", (input) => {
    expect(normalizePhoneOrigin(input)).toBeNull();
  });
});

describe("optional phone setup", () => {
  it("defaults to skipping without account access or changes", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [0] });
    const result = await runPhoneSetup(options, ui.io, deps);
    expect(result).toEqual({ options });
    expect(result.options).toBe(options);
    expect(ui.io.choose).toHaveBeenCalledWith("Use OpenMausBot on your phone?", expect.any(Array), 0);
    expect(deps.accountReady).not.toHaveBeenCalled();
    expect(deps.login).not.toHaveBeenCalled();
    ui.consumed();
  });

  it("requires explicit public exposure/download consent before managed sign-in", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [1, 0], confirms: [true] });
    const original = { ...options };
    expect(await runPhoneSetup(options, ui.io, deps)).toEqual({
      phone: "ios", options: { ...options, tunnel: true, publicUrl: undefined, client: true, pair: true },
    });
    expect(options).toEqual(original);
    expect(deps.login).toHaveBeenCalledWith(options, ui.io);
    expect(ui.io.confirm).toHaveBeenCalledWith(expect.stringContaining("public endpoint"), false);
    expect(vi.mocked(ui.io.confirm).mock.invocationCallOrder[0]).toBeLessThan(deps.accountReady.mock.invocationCallOrder[0]!);
    expect(ui.lines.join("\n")).toContain("basic server identity are public");
    expect(ui.lines.join("\n")).toContain("download the Cloudflare connector");
    ui.consumed();
  });

  it("declining exposure returns to routes and may skip without sign-in", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [2, 0, 4], confirms: [false] });
    expect(await runPhoneSetup(options, ui.io, deps)).toEqual({ options });
    expect(deps.accountReady).not.toHaveBeenCalled();
    expect(deps.login).not.toHaveBeenCalled();
    ui.consumed();
  });

  it("reuses an existing account after consent without another email", async () => {
    const deps = dependencies();
    deps.accountReady.mockReturnValue(true);
    const ui = prompts({ choices: [2, 0], confirms: [true] });
    expect((await runPhoneSetup(options, ui.io, deps)).phone).toBe("android");
    expect(deps.login).not.toHaveBeenCalled();
    expect(ui.lines.join("\n")).toContain("saved OpenMausBot account");
    ui.consumed();
  });

  it.each([1, new Error("secret-token-never-print")])("does not select managed access after failed sign-in: %s", async (failure) => {
    const deps = dependencies();
    if (failure instanceof Error) deps.login.mockRejectedValue(failure);
    else deps.login.mockResolvedValue(failure);
    const ui = prompts({ choices: [1, 0], confirms: [true] });
    expect(await runPhoneSetup(options, ui.io, deps)).toEqual({ options });
    expect(ui.lines.join("\n")).not.toContain("secret-token-never-print");
    expect(ui.lines.join("\n")).toContain("provider setup is still saved");
    ui.consumed();
  });

  it("does not attempt sign-in if saved-account inspection fails", async () => {
    const deps = dependencies();
    deps.accountReady.mockRejectedValue(new Error("credential-document-secret"));
    const ui = prompts({ choices: [1, 0], confirms: [true] });
    expect(await runPhoneSetup(options, ui.io, deps)).toEqual({ options });
    expect(deps.login).not.toHaveBeenCalled();
    expect(ui.lines.join("\n")).not.toContain("credential-document-secret");
  });

  it("supports existing Tailscale only after consent, without installing it or signing in", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [2, 1], confirms: [true] });
    expect(await runPhoneSetup(options, ui.io, deps)).toEqual({
      phone: "android", options: { ...options, tailscale: true, publicUrl: undefined, client: true, pair: true },
    });
    expect(ui.io.confirm).toHaveBeenCalledWith(expect.stringContaining("tailnet"), false);
    expect(deps.login).not.toHaveBeenCalled();
    expect(ui.lines.join("\n")).toContain("already be installed");
    ui.consumed();
  });

  it("rejects a pasted secret without echoing it, then accepts an advanced HTTPS origin", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [2, 2, 2], answers: ["https://user:secret@example.com/#code=credential", "https://maus.example/"] });
    expect(await runPhoneSetup(options, ui.io, deps)).toEqual({
      phone: "android", options: { ...options, publicUrl: "https://maus.example", client: true, pair: true },
    });
    expect(ui.lines.join("\n")).not.toContain("user:secret");
    expect(ui.lines.join("\n")).not.toContain("code=credential");
    expect(deps.login).not.toHaveBeenCalled();
    ui.consumed();
  });

  it("offers back and skip without enabling any route", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [1, 2, 3, 0], answers: [""] });
    expect(await runPhoneSetup(options, ui.io, deps)).toEqual({ options });
    expect(deps.login).not.toHaveBeenCalled();
    ui.consumed();
  });

  it.each([
    { publicUrl: "https://maus.example/" }, { tailscale: true }, { tunnel: true },
  ])("reuses explicit existing route options without a nested chooser: %j", async (route) => {
    const deps = dependencies();
    deps.accountReady.mockReturnValue(true);
    const ui = prompts({ choices: [1] });
    const input = { ...options, ...route };
    const result = await runPhoneSetup(input, ui.io, deps);
    expect(result.phone).toBe("ios");
    expect(result.options.client).toBe(true);
    expect(ui.io.choose).toHaveBeenCalledTimes(1);
    expect(ui.io.confirm).not.toHaveBeenCalled();
    expect(deps.login).not.toHaveBeenCalled();
    ui.consumed();
  });

  it("does not mistake a localhost publicUrl for phone connectivity", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [1, 4] });
    const input = { ...options, publicUrl: "http://127.0.0.1:18799" };
    expect(await runPhoneSetup(input, ui.io, deps)).toEqual({ options: input });
    expect(ui.lines.join("\n")).toContain("localhost or LAN-IP link will not connect");
    ui.consumed();
  });

  it("propagates Ctrl-C before route selection without changing options", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [new SetupCancelled()] });
    await expect(runPhoneSetup(options, ui.io, deps)).rejects.toBeInstanceOf(SetupCancelled);
    expect(deps.login).not.toHaveBeenCalled();
    expect(options.tunnel).toBe(false);
  });

  it("propagates Ctrl-C during account sign-in without selecting or saving a route", async () => {
    const deps = dependencies();
    deps.login.mockRejectedValue(new SetupCancelled());
    const ui = prompts({ choices: [1, 0], confirms: [true] });
    await expect(runPhoneSetup(options, ui.io, deps)).rejects.toBeInstanceOf(SetupCancelled);
    expect(options.tunnel).toBe(false);
  });
});

describe("phone pairing instructions", () => {
  it.each(["ios", "android"] as const)("refuses phone instructions for an unready %s route", (phone) => {
    const text = phonePairingInstructions(phone, { origin: "https://maus.example", ready: false }).join("\n");
    expect(text).toContain("not ready");
    expect(text).not.toContain("https://maus.example");
    expect(text).not.toContain("already connected");
  });

  it.each(["https://localhost", "https://maus.example/#code=secret", null])("never repeats a local or credential-bearing origin: %s", (origin) => {
    const text = phonePairingInstructions("ios", { origin, ready: true }).join("\n");
    expect(text).toContain("not ready");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("localhost");
  });

  it("describes iOS browser/native options without claiming an app-store release", () => {
    const text = phonePairingInstructions("ios", { origin: "https://maus.example", ready: true }).join("\n");
    expect(text).toContain("Safari");
    expect(text).toContain("already have");
    expect(text).toContain("https://maus.example/pair");
    expect(text).toContain("does not mean the phone is paired");
    expect(text).toContain("not settings or pairing administration");
    expect(text).not.toMatch(/apps\.apple|testflight|play\.google/);
  });

  it("describes Android web pairing, not native app compatibility", () => {
    const text = phonePairingInstructions("android", { origin: "https://maus.example", ready: true }).join("\n");
    expect(text).toContain("web browser");
    expect(text).toContain("not the Android native pairing scanner");
    expect(text).toContain("five minutes");
  });
});
