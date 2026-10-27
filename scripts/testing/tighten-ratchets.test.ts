import { describe, expect, it } from "vitest";

import { tightenRoutes, tightenSizes } from "../tighten-ratchets.mjs";

const SIZES = `const LINES: Record<string, number> = {
  "server/index.ts": 16200,
  "src/a.tsx": 1300,
  "src/b.ts": 1100,
  "src/gone.ts": 1200,
};
`;

describe("tighten-ratchets", () => {
  it("lowers a shrunk file's number, keeps a grown one, and drops files gone or under 1,000 lines", () => {
    const counts: Record<string, number | null> = { "server/index.ts": 16150, "src/a.tsx": 1310, "src/b.ts": 900, "src/gone.ts": null };
    const { text, changes } = tightenSizes(SIZES, (file: string) => counts[file] ?? null);
    expect(text).toBe(`const LINES: Record<string, number> = {
  "server/index.ts": 16150,
  "src/a.tsx": 1300,
};
`);
    expect(changes).toEqual(["server/index.ts: 16200 → 16150", "src/b.ts: removed (900 lines)", "src/gone.ts: removed (gone)"]);
  });

  it("lowers a route needle's number, whichever quotes it is written in, and never raises one", () => {
    const routes = `const EXACT: Record<string, number> = {
  // a comment stays
  'path === "/': 92,
  "path.match(": 26,
};
`;
    const times: Record<string, number> = { 'path === "/': 90, "path.match(": 30 };
    const { text, changes } = tightenRoutes(routes, (needle: string) => times[needle]!);
    expect(text).toContain(`  // a comment stays\n  'path === "/': 90,\n  "path.match(": 26,`);
    expect(changes).toEqual(['path === "/: 92 → 90']);
  });
});
