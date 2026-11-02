// server/index.ts may not gain request-path guards; new routes go in server/routes (see its README).
// Counted per occurrence. A count may not go above its number here; scripts/tighten-ratchets.mjs lowers the numbers
// at each release, so a PR that moves a route out leaves them alone.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const INDEX = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");

const EXACT: Record<string, number> = {
  // Internal harness routes have no server/routes module yet; moving them out is the follow-up that lowers this.
  'path === "/': 91,
  "path.match(": 24,
  "path.startsWith(": 6,
  ".exec(path)": 1,
  ".test(path)": 0,
  ".includes(path)": 2,
};

const count = (needle: string) => INDEX.split(needle).length - 1;

describe("server/index.ts gains no route handlers", () => {
  it("matches request paths no more often than written here", () => {
    const changed = Object.entries(EXACT).flatMap(([needle, written]) => {
      const n = count(needle);
      if (n > written) return [`${needle} appears ${n} times, more than ${written}: put the new route in server/routes`];
      return [];
    });
    expect(changed, "See server/routes/README.md").toEqual([]);
  });
});
