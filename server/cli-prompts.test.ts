import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSetupIo, SetupCancelled } from "./cli-prompts.ts";

function terminal(raw = false, display: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: raw,
    setRawMode: vi.fn((enabled: boolean) => { input.isRaw = enabled; }),
  });
  input.pause();
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }, display);
  let transcript = "";
  output.on("data", (chunk) => { transcript += String(chunk); });
  return { input, output, io: defaultSetupIo(input, output), text: () => transcript };
}

const signals = ["SIGINT", "SIGTERM", "exit"] as const;
const signalCounts = () => signals.map((signal) => process.listenerCount(signal));
function expectClean(fixture: ReturnType<typeof terminal>, raw = false) {
  expect(fixture.input.isRaw).toBe(raw);
  if (!fixture.input.readableEnded) expect(fixture.input.isPaused()).toBe(true);
  expect(fixture.input.listenerCount("data")).toBe(0);
  expect(fixture.input.listenerCount("keypress")).toBe(0);
  expect(fixture.output.listenerCount("resize")).toBe(0);
}

describe("Clack setup adapter", () => {
  beforeEach(() => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("NO_COLOR", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the default index and Clack arrow navigation, including split sequences", async () => {
    const fixture = terminal();
    const answer = fixture.io.choose("Provider", ["First", "Second", "Third"], 1);
    expect(stripVTControlCharacters(fixture.text())).toContain("↑/↓");
    fixture.input.write("\u001b");
    fixture.input.write("[");
    fixture.input.write("B");
    fixture.input.write("\r");
    expect(await answer).toBe(2);
    expectClean(fixture);
  });

  it("selects the first item by default and preserves explicit defaults", async () => {
    const fixture = terminal();
    const first = fixture.io.choose("Model", ["First", "Second"]);
    fixture.input.write("\r");
    expect(await first).toBe(0);
    const second = fixture.io.choose("Model", ["First", "Second"], 1);
    fixture.input.write("\r");
    expect(await second).toBe(1);
    expectClean(fixture);
  });

  it("rejects unavailable choices and invalid defaults before entering raw mode", async () => {
    const fixture = terminal();
    await expect(fixture.io.choose("Model", [])).rejects.toThrow("no choices");
    for (const invalid of [-1, 2, 0.5, NaN]) {
      await expect(fixture.io.choose("Model", ["First", "Second"], invalid)).rejects.toThrow("default choice");
    }
    expect(fixture.input.setRawMode).not.toHaveBeenCalled();
    expect(fixture.text()).toBe("");
  });

  it("lets Clack bound long lists and render narrow terminal labels", async () => {
    const fixture = terminal(false, { columns: 38, rows: 12 });
    const answer = fixture.io.choose("Choose a model", Array.from({ length: 50 }, (_, i) => `Model ${i + 1}: ${"long label ".repeat(6)}`));
    expect(fixture.text()).not.toContain("Model 8:");
    fixture.input.write("\u001b[A\r");
    expect(await answer).toBe(49); // Clack wraps at the end of the option list.
    expect(stripVTControlCharacters(fixture.text())).toContain("Model 50:");
    expectClean(fixture);
  });

  it("uses Clack text input without changing whitespace or empty answers", async () => {
    const fixture = terminal();
    const entered = fixture.io.ask("Account: ");
    fixture.input.write("  name@example.com  \r");
    expect(await entered).toBe("  name@example.com  ");
    const empty = fixture.io.ask("Optional: ");
    fixture.input.write("\r");
    expect(await empty).toBe("");
    expectClean(fixture);
  });

  it("keeps confirmation default-negative and supports defaults, arrows and y/n", async () => {
    const fixture = terminal();
    const declined = fixture.io.confirm("Replace?");
    fixture.input.write("\r");
    expect(await declined).toBe(false);
    const accepted = fixture.io.confirm("Save?", true);
    fixture.input.write("\r");
    expect(await accepted).toBe(true);
    const arrow = fixture.io.confirm("Continue?");
    fixture.input.write("\u001b[A\r");
    expect(await arrow).toBe(true);
    const yes = fixture.io.confirm("Continue?");
    fixture.input.write("y");
    expect(await yes).toBe(true);
    const no = fixture.io.confirm("Replace?", true);
    fixture.input.write("n");
    expect(await no).toBe(false);
    expectClean(fixture);
  });

  it.each([true, false])("never echoes pasted secrets with rich output=%s", async (rich) => {
    const fixture = terminal(false, { isTTY: rich });
    const answer = fixture.io.secret("API key: ");
    expect(fixture.input.isRaw).toBe(true);
    fixture.input.write("\u001b[20");
    fixture.input.write("0~sk-private-pasted-key\u001b[201~\r");
    expect(await answer).toBe("sk-private-pasted-key");
    expect(fixture.text()).not.toContain("sk-private");
    expect(fixture.text()).not.toContain("pasted-key");
    if (rich) expect(fixture.text()).toContain("*");
    else expect(fixture.text()).toBe("API key: \n");
    expectClean(fixture);
  });

  it.each([true, false])("supports hidden corrections and split UTF-8 with rich output=%s", async (rich) => {
    const fixture = terminal(true, { isTTY: rich });
    const answer = fixture.io.secret("Key: ");
    fixture.input.write("mistake\u0015sk-secrex\u007ft");
    const encoded = Buffer.from("é");
    fixture.input.write(encoded.subarray(0, 1));
    fixture.input.write(encoded.subarray(1));
    fixture.input.write("\r");
    expect(await answer).toBe("sk-secreté");
    expect(fixture.text()).not.toContain("sk-secret");
    expectClean(fixture, true);
  });

  it.each(["ask", "secret", "choose", "confirm"] as const)("cancels %s on Ctrl-C/D and restores all prompt resources", async (kind) => {
    for (const rich of [true, false]) for (const key of ["\u0003", "\u0004"]) {
      const fixture = terminal(true, { isTTY: rich });
      const before = signalCounts();
      const pending = kind === "choose" ? fixture.io.choose("Provider", ["First", "Second"]) : fixture.io[kind]("Question");
      const rejected = expect(pending).rejects.toBeInstanceOf(SetupCancelled);
      fixture.input.write("\u001b[");
      fixture.input.write(key);
      await rejected;
      expectClean(fixture, true);
      expect(signalCounts()).toEqual(before);
    }
  });

  it("translates Clack's Escape cancellation into SetupCancelled", async () => {
    const fixture = terminal();
    const pending = fixture.io.choose("Provider", ["First"]);
    const rejected = expect(pending).rejects.toBeInstanceOf(SetupCancelled);
    fixture.input.write("\u001b");
    await rejected;
    expectClean(fixture);
  });

  it.each(["end", "close", "error", "output-error", "SIGINT", "SIGTERM"])("cleans up a hidden prompt on %s", async (kind) => {
    for (const rich of [true, false]) {
      const fixture = terminal(false, { isTTY: rich });
      const previous = new Set(process.listeners(kind));
      const before = signalCounts();
      const pending = fixture.io.secret("Key: ");
      const rejected = expect(pending).rejects.toThrow(kind.includes("error") ? "disconnected" : "Setup cancelled");
      fixture.input.write("sk-do-not-print");
      if (kind === "end") fixture.input.end();
      else if (kind === "close") fixture.input.emit("close");
      else if (kind === "error") fixture.input.emit("error", new Error("input disconnected"));
      else if (kind === "output-error") fixture.output.emit("error", new Error("output disconnected"));
      else process.listeners(kind).find((listener) => !previous.has(listener))!();
      await rejected;
      expect(fixture.text()).not.toContain("sk-do-not-print");
      expectClean(fixture);
      expect(signalCounts()).toEqual(before);
    }
  });

  it("preserves an already-flowing input stream", async () => {
    const fixture = terminal();
    fixture.input.resume();
    const pending = fixture.io.choose("Provider", ["First"]);
    fixture.input.write("\r");
    await pending;
    expect(fixture.input.readableFlowing).toBe(true);
    expect(fixture.input.isRaw).toBe(false);
  });

  it("does not retain a text decoder that could echo the following secret", async () => {
    const fixture = terminal();
    const selected = fixture.io.choose("Provider", ["API key"]);
    fixture.input.write("\r");
    await selected;
    const account = fixture.io.ask("Name: ");
    fixture.input.write("My account\r");
    await account;
    const secret = fixture.io.secret("Key: ");
    fixture.input.write("sk-never-echo-this\r");
    expect(await secret).toBe("sk-never-echo-this");
    expect(fixture.text()).not.toContain("sk-never-echo-this");
    expectClean(fixture);
  });

  it("sanitizes provider labels, log output and questions before rendering", async () => {
    const fixture = terminal();
    fixture.io.log("Provider \u001b[31mred\u001b[0m\u0007");
    expect(fixture.text()).toBe("Provider red\n");
    const selected = fixture.io.choose("Model\u001b[2J", ["Untrusted\u001b[2J\nlabel"]);
    fixture.input.write("\r");
    await selected;
    const answer = fixture.io.ask("Account\u001b[2J\u0007: ");
    fixture.input.write("name\r");
    await answer;
    expect(fixture.text()).not.toContain("\u001b[2J");
    expect(fixture.text()).not.toContain("\u0007");
    expect(stripVTControlCharacters(fixture.text())).toContain("Untrusted label");
  });

  it("refuses hidden input without a terminal before printing or changing raw mode", () => {
    const fixture = terminal();
    fixture.input.isTTY = false;
    expect(() => fixture.io.secret("Key: ")).toThrow("interactive terminal");
    expect(fixture.text()).toBe("");
    expect(fixture.input.setRawMode).not.toHaveBeenCalled();
  });

  it.each(["dumb", "NO_COLOR", "redirected", "narrow", "short"])("uses an escape-free numeric fallback for %s output", async (mode) => {
    if (mode === "dumb") vi.stubEnv("TERM", "dumb");
    if (mode === "NO_COLOR") vi.stubEnv("NO_COLOR", "");
    const fixture = terminal(false, { isTTY: mode !== "redirected", columns: mode === "narrow" ? 16 : 80, rows: mode === "short" ? 5 : 24 });
    const pending = fixture.io.choose("Provider", ["First", "Second"], 0);
    expect(fixture.text()).toContain("1. First (default)");
    fixture.input.write("9\r");
    await vi.waitFor(() => expect(fixture.text()).toContain("Enter a number from 1 to 2."));
    fixture.input.write("2\r");
    expect(await pending).toBe(1);
    expect(fixture.text()).not.toContain("\u001b");
    expectClean(fixture);
  });

  it("pages plain long lists and accepts multi-digit numeric choices", async () => {
    const fixture = terminal(false, { isTTY: false });
    const pending = fixture.io.choose("Model", Array.from({ length: 50 }, (_, index) => `Model ${index + 1}`));
    expect(fixture.text()).not.toContain("21. Model");
    fixture.input.write("n\r");
    await vi.waitFor(() => expect(fixture.text()).toContain("21. Model"));
    fixture.input.write("42\r");
    expect(await pending).toBe(41);
    expectClean(fixture);
  });

  it("preserves choice and consent defaults in plain mode and retries invalid confirmations", async () => {
    const fixture = terminal(false, { isTTY: false });
    const select = fixture.io.choose("Model", ["First", "Second"], 1);
    fixture.input.write("\r");
    expect(await select).toBe(1);
    const confirmed = fixture.io.confirm("Save?", true);
    fixture.input.write("\r");
    expect(await confirmed).toBe(true);
    const declined = fixture.io.confirm("Replace?");
    fixture.input.write("\r");
    expect(await declined).toBe(false);
    const retried = fixture.io.confirm("Continue?");
    fixture.input.write("maybe\r");
    await vi.waitFor(() => expect(fixture.text()).toContain("Enter yes or no."));
    fixture.input.write("yes\r");
    expect(await retried).toBe(true);
    expectClean(fixture);
  });
});
