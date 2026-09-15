// The Windows SAPI voice engine, driven against a stub runner — what we
// spawn, what we parse, and the temp-file hygiene are the things that break.
import { describe, expect, it } from "vitest";

import { listWindowsVoices, parseVoiceList, windowsVoicesAvailable } from "./windows-voices.ts";
import type { Runner } from "./system-voices.ts";

const LISTING = [
  "Microsoft David Desktop\ten-US\tMale",
  "Microsoft Zira Desktop\ten-US\tFemale",
  "Microsoft Hedda Desktop\tde-DE\tFemale",
  "", // trailing blank
].join("\n");

/** A stand-in for powershell.exe: records argv, answers the voice-listing
 * script with the listing above, and writes a tiny WAV where SetOutputToWaveFile points. */
const fakePowerShell = (record: string[][]) => async (_file: string, args: string[]) => {
  record.push(args);
  const command = args.at(-1) ?? "";
  if (command.includes("GetInstalledVoices")) return { stdout: LISTING };
  const out = /SetOutputToWaveFile\('([^']+)/.exec(command)?.[1];
  if (out) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from("RIFF....WAVEfmt "));
  }
  return { stdout: "" };
};

describe("windowsVoicesAvailable", () => {
  it("is win32-only", () => {
    expect(windowsVoicesAvailable("win32")).toBe(true);
    expect(windowsVoicesAvailable("darwin")).toBe(false);
    expect(windowsVoicesAvailable("linux")).toBe(false);
  });
});

describe("parseVoiceList", () => {
  it("parses the name/culture/gender rows, blanks and all", () => {
    expect(parseVoiceList(LISTING)).toEqual([
      { id: "Microsoft David Desktop", label: "Microsoft David Desktop", description: "en-US — Male" },
      { id: "Microsoft Zira Desktop", label: "Microsoft Zira Desktop", description: "en-US — Female" },
      { id: "Microsoft Hedda Desktop", label: "Microsoft Hedda Desktop", description: "de-DE — Female" },
    ]);
  });

  it("tolerates rows with missing culture or gender", () => {
    expect(parseVoiceList("Solo Voice\t\n\n")).toEqual([{ id: "Solo Voice", label: "Solo Voice" }]);
    expect(parseVoiceList("")).toEqual([]);
  });
});

describe("listWindowsVoices", () => {
  it("asks PowerShell for the installed SAPI voices", async () => {
    const record: string[][] = [];
    const run: Runner = fakePowerShell(record);
    const voices = await listWindowsVoices(run);
    expect(voices.map((v) => v.id)).toContain("Microsoft David Desktop");
    const command = record[0].at(-1) ?? "";
    expect(command).toContain("System.Speech");
    expect(command).toContain("GetInstalledVoices");
    expect(record[0].slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("degrades to no voices when the engine is absent", async () => {
    const run: Runner = async () => {
      throw new Error("powershell not found");
    };
    expect(await listWindowsVoices(run)).toEqual([]);
  });
});
