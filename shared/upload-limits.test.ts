import { describe, expect, it } from "vitest";
import { FILE_MAX_BYTES, fileMaxBytes } from "./upload-limits.ts";

describe("fileMaxBytes (#4705)", () => {
  it("keeps the shipped 25 MiB when the setting is missing, empty, or invalid", () => {
    expect(fileMaxBytes({} as NodeJS.ProcessEnv)).toBe(FILE_MAX_BYTES);
    expect(fileMaxBytes({ OMB_FILE_MAX_BYTES: "" } as NodeJS.ProcessEnv)).toBe(FILE_MAX_BYTES);
    expect(fileMaxBytes({ OMB_FILE_MAX_BYTES: "   " } as NodeJS.ProcessEnv)).toBe(FILE_MAX_BYTES);
    expect(fileMaxBytes({ OMB_FILE_MAX_BYTES: "nope" } as NodeJS.ProcessEnv)).toBe(FILE_MAX_BYTES);
    expect(fileMaxBytes({ OMB_FILE_MAX_BYTES: "-5" } as NodeJS.ProcessEnv)).toBe(FILE_MAX_BYTES);
    expect(fileMaxBytes({ OMB_FILE_MAX_BYTES: "0" } as NodeJS.ProcessEnv)).toBe(FILE_MAX_BYTES);
    expect(fileMaxBytes({ OMB_FILE_MAX_BYTES: "1.5" } as NodeJS.ProcessEnv)).toBe(FILE_MAX_BYTES);
  });

  it("reads a positive integer override in bytes", () => {
    expect(fileMaxBytes({ OMB_FILE_MAX_BYTES: "52428800" } as NodeJS.ProcessEnv)).toBe(52_428_800);
    expect(fileMaxBytes({ OMB_FILE_MAX_BYTES: " 26214400 " } as NodeJS.ProcessEnv)).toBe(26_214_400);
  });
});
