import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DATA_DB_FILE } from "./data/engine.ts";
import { BUILT_IN_DATA_SYSTEM_PROMPT } from "./data/instructions.ts";
import { SHEET_FILE } from "./data/sheet.ts";
import { DATA_TOOLS_POINTER, ThreadChoices, botHasData, dataPrompts, mentionsDataWork } from "./data-prompt.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const folders: string[] = [];
const folder = () => { const made = mkdtempSync(join(tmpdir(), "omb-data-prompt-")); folders.push(made); return made; };
afterAll(async () => { for (const made of folders) await removeTempDir(made); });

describe("the Data section of the prompt", () => {
  it("is asked for by words about files, sheets, SQL and charts, in any case", () => {
    for (const text of ["Load sales.CSV and chart revenue", "what's in this spreadsheet?", "run this SQL", "Plot it by month", "analyse my orders.xlsx", "Data tab"]) {
      expect(mentionsDataWork(text), text).toBe(true);
    }
    for (const text of ["Say hi.", "Remind me at noon"]) expect(mentionsDataWork(text), text).toBe(false);
  });

  it("knows a bot that has used Data by its database or Data sheet, without opening either", () => {
    const root = folder();
    const at = (botId: string) => join(root, botId);
    for (const botId of ["fresh", "loaded", "charted"]) mkdirSync(at(botId));
    writeFileSync(join(at("loaded"), DATA_DB_FILE), "");
    writeFileSync(join(at("charted"), SHEET_FILE), "{}");
    expect(botHasData("fresh", at)).toBe(false);
    expect(botHasData("missing", at)).toBe(false);
    expect(botHasData("loaded", at)).toBe(true);
    expect(botHasData("charted", at)).toBe(true);
  });

  it("is the guide where Data is in use and a one-line pointer elsewhere, chosen on a conversation's first turn and kept", () => {
    const prompt = dataPrompts({ hasData: (botId) => botId === "user-of-data" });
    expect(prompt("fresh", "t1", "Say hi.")).toBe(DATA_TOOLS_POINTER);
    expect(prompt("fresh", "t1", "Load q3.csv"), "a warm engine is not relaunched by it").toBe(DATA_TOOLS_POINTER);
    expect(prompt("fresh", "t2", "Load q3.csv")).toBe(BUILT_IN_DATA_SYSTEM_PROMPT);
    expect(prompt("fresh", "t2", "Thanks.")).toBe(BUILT_IN_DATA_SYSTEM_PROMPT);
    expect(prompt("user-of-data", "t3", "Say hi.")).toBe(BUILT_IN_DATA_SYSTEM_PROMPT);
    // the pointer names every tool the guide does, in far fewer bytes
    for (const tool of ["data_load", "data_describe", "data_sql", "data_show", "data_export"]) expect(DATA_TOOLS_POINTER).toContain(tool);
    expect(Buffer.byteLength(DATA_TOOLS_POINTER)).toBeLessThan(Buffer.byteLength(BUILT_IN_DATA_SYSTEM_PROMPT) / 5);
  });

  it("remembers a bounded number of conversations", () => {
    const threads = new ThreadChoices(2);
    threads.set("a", true);
    threads.set("b", false);
    threads.set("c", true);
    expect(threads.get("a")).toBeUndefined();
    expect(threads.get("b")).toBe(false);
    expect(threads.get("c")).toBe(true);
  });
});
