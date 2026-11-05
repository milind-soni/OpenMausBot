import { describe, expect, it } from "vitest";

import { skillImportLines } from "./skill-import";

describe("what an import says it brought", () => {
  it("names what arrived, then up to three things left out and why", () => {
    expect(skillImportLines([
      { name: "pdf", files: 12, scripts: 1, skipped: [], skippedCount: 0 },
      { name: "tidy", files: 1, scripts: 0, skipped: [{ path: "video.mp4", reason: "large" }], skippedCount: 1 },
      {
        name: "big",
        files: 200,
        scripts: 3,
        skipped: [
          { path: ".github/", reason: "hidden" },
          { path: "link.md", reason: "link" },
          { path: "refs/z.md", reason: "full" },
          { path: "refs/zz.md", reason: "full" },
        ],
        skippedCount: 9,
      },
      { name: "solo", files: 1, scripts: 0, skipped: [{ path: "", reason: "unlisted" }], skippedCount: 1 },
    ])).toEqual([
      "Imported pdf: 12 files and 1 script.",
      "Imported tidy: 1 file. Left out: video.mp4 (over 2 MB).",
      "Imported big: 200 files and 3 scripts. Left out: .github/ (hidden), link.md (a link), refs/z.md (past the folder's limit), and 6 more.",
      "Imported solo: 1 file. Left out: GitHub didn't list the folder, so only the main file came in.",
    ]);
  });
});
