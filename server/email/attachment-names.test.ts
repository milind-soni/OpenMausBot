import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { safeAttachmentName, saveAttachment } from "./client.ts";

const root = mkdtempSync(join(tmpdir(), "omb-mail-names-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("attachment filenames on disk", () => {
  it.each([
    { label: "CJK", stem: "报告".repeat(80), suffix: ".pdf" },
    { label: "supplementary letters", stem: "𠀀".repeat(80), suffix: ".json" },
  ])("saves long $label names without splitting characters", ({ stem, suffix }) => {
    const name = safeAttachmentName(`${stem}${suffix}`, 0);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(252);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(suffix)).toBe(true);
    expect(Buffer.from(name).toString("utf8")).toBe(name);

    const folder = mkdtempSync(join(root, "files-"));
    const first = saveAttachment(folder, name, Buffer.from("first"));
    const next = saveAttachment(folder, name, Buffer.from("second"));
    expect(Buffer.byteLength(basename(next))).toBeLessThanOrEqual(255);
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(next, "utf8")).toBe("second");
  });

  it("keeps ordinary names and the existing character limit", () => {
    expect(safeAttachmentName("Rechnung März 2026.pdf", 0)).toBe("Rechnung März 2026.pdf");
    expect(safeAttachmentName(`${"x".repeat(300)}.pdf`, 0)).toBe(`${"x".repeat(116)}.pdf`);
    expect(safeAttachmentName(undefined, 2)).toBe("attachment-3");
  });
});
