import { describe, expect, it } from "vitest";

import { storeReadsIn, tightenRoutes, tightenSizes, tightenStoreReads } from "../tighten-ratchets.mjs";

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

  it("counts useStore() calls but not its definition, and lowers or drops a file's number, never raising one", () => {
    expect(storeReadsIn("export function useStore() {}\nconst a = useStore();\nconst b = useStore().state;\nuseStoreRef();")).toBe(2);
    expect(storeReadsIn("// useStore() in a comment\n/* and useStore() here */\nconst url = \"https://x\"; const a = useStore();")).toBe(1);
    expect(storeReadsIn("import { useStore as readStore } from \"./store\";\nconst a = readStore();\nconst b = readStore().state;")).toBe(2);
    const reads = `const READS: Record<string, number> = {
  "src/a.tsx": 3,
  "src/b.tsx": 2,
  "src/c.tsx": 1,
  "src/gone.tsx": 1,
};
`;
    const now: Record<string, number | null> = { "src/a.tsx": 1, "src/b.tsx": 4, "src/c.tsx": 0, "src/gone.tsx": null };
    const { text, changes } = tightenStoreReads(reads, (file: string) => now[file] ?? null);
    expect(text).toBe(`const READS: Record<string, number> = {
  "src/a.tsx": 1,
  "src/b.tsx": 2,
};
`);
    expect(changes).toEqual(["src/a.tsx: 3 → 1", "src/c.tsx: removed (no calls)", "src/gone.tsx: removed (gone)"]);
  });
});
