import { afterEach, describe, expect, it, vi } from "vitest";

import { coerceRows, parseTemporal } from "./render.ts";

afterEach(() => vi.unstubAllEnvs());

describe.each(["UTC", "America/New_York", "Asia/Shanghai"])("historical chart dates in %s", (zone) => {
  it.each(["0000-02-29", "0001-01-01", "0004-02-29", "0099-12-31"])("keeps the year and calendar date in %s", (text) => {
    vi.stubEnv("TZ", zone);
    const date = parseTemporal(text) as Date;
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()])
      .toEqual([...text.split("-").map(Number), 0]);
  });

  it("keeps the wall-clock time and fractional seconds of an early timestamp", () => {
    vi.stubEnv("TZ", zone);
    const date = parseTemporal("0004-02-29 12:34:56.123456") as Date;
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()])
      .toEqual([4, 1, 29, 12, 34, 56, 123]);
  });

  it("preserves early SQL dates when making chart rows", () => {
    vi.stubEnv("TZ", zone);
    const rows = coerceRows([["0001-01-01", 10], ["2024-03-01", 20]], [{ name: "x", type: "DATE" }, { name: "y", type: "INTEGER" }]);
    expect((rows[0]!.x as Date).getFullYear()).toBe(1);
    expect((rows[1]!.x as Date).getFullYear()).toBe(2024);
    expect(rows.map((row) => row.y)).toEqual([10, 20]);
  });
});
