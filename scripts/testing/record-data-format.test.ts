import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { declaredDataFormat, releasedRecord } from "../record-data-format.mjs";
import { DATA_FORMAT } from "../../server/data-format.ts";

const source = readFileSync(join(import.meta.dirname, "..", "..", "server", "data-format.ts"), "utf8");

describe("record-data-format", () => {
  it("reads the two numbers the server declares", () => {
    expect(declaredDataFormat(source)).toEqual(DATA_FORMAT);
    expect(declaredDataFormat("export const DATA_FORMAT = { writes: 2, reads: 3 } as const;")).toEqual({ writes: 2, reads: 3 });
    expect(() => declaredDataFormat("export const DATA_FORMAT = formats();")).toThrow("no longer declares DATA_FORMAT");
  });

  it("records them under the version being released", () => {
    expect(JSON.parse(releasedRecord("9.9.9", source))).toEqual({ version: "9.9.9", ...DATA_FORMAT });
  });
});
