import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildZip, type ZipFixtureMember } from "./testing/zip-fixture.ts";

const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-xmind-test-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const { outlineFromJson, outlineFromXml, saveXmindUpload } = await import("./xmind.ts");

afterAll(() => rmSync(DATA_ROOT, { recursive: true, force: true }));

const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";

const CONTENT_JSON = JSON.stringify([
  {
    title: "Iteration 12",
    rootTopic: {
      title: "Release\nplan",
      labels: ["Q4", "core"],
      markers: [{ markerId: "priority-1" }],
      notes: { plain: { content: "Ship by Friday.\n\nNo scope creep." } },
      children: {
        attached: [
          { title: "Backend", children: { attached: [{ title: "Migrate <db>", href: "https://example.com/db" }] } },
          { title: "" },
        ],
        detached: [{ title: "Parking lot" }],
      },
    },
  },
  { title: "", rootTopic: { title: "Risks" } },
]);

const EXPECTED = [
  "# Iteration 12",
  "",
  "- Release plan (labels: Q4, core; markers: priority-1)",
  "  > Ship by Friday.",
  "  > No scope creep.",
  "  - Backend",
  "    - Migrate <db> (link: https://example.com/db)",
  "  - (untitled)",
  "  - Parking lot (floating)",
  "",
  "# Sheet 2",
  "",
  "- Risks",
  "",
].join("\n");

const CONTENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">
  <!-- a comment with <topic> inside -->
  <sheet id="s1">
    <topic id="t1">
      <title>Release
plan</title>
      <labels><label>Q4</label><label>core</label></labels>
      <marker-refs><marker-ref marker-id="priority-1"/></marker-refs>
      <notes><plain><![CDATA[Ship by Friday.

No scope creep.]]></plain><html><xhtml:p>Ship by Friday.</xhtml:p></html></notes>
      <children>
        <topics type="attached">
          <topic id="t2"><title>Backend</title>
            <children><topics type="attached">
              <topic id="t3" xlink:href="https://example.com/db"><title>Migrate &lt;db&gt;</title></topic>
            </topics></children>
          </topic>
          <topic id="t4"><title/></topic>
        </topics>
        <topics type="detached"><topic id="t5"><title>Parking &#108;ot</title></topic></topics>
      </children>
    </topic>
    <title>Iteration 12</title>
  </sheet>
  <sheet id="s2"><topic id="t6"><title>Risks</title></topic></sheet>
</xmap-content>`;

async function* body(bytes: Buffer): AsyncIterable<Uint8Array> {
  yield bytes.subarray(0, 7);
  yield bytes.subarray(7);
}

const archive = (members: ZipFixtureMember[]) => body(buildZip(members));
const scratchDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith("omb-xmind-") && !name.startsWith("omb-xmind-test-"));

describe("XMind outlines", () => {
  it("renders content.json as one section per sheet with notes, labels, markers and floating topics", () => {
    expect(outlineFromJson(CONTENT_JSON)).toBe(EXPECTED);
  });

  it("renders the legacy content.xml to the same outline", () => {
    expect(outlineFromXml(CONTENT_XML)).toBe(EXPECTED);
  });

  it("keeps summary and callout topics from content.json", () => {
    const source = JSON.stringify([
      { rootTopic: { title: "R", children: { attached: [{ title: "A" }], summary: [{ title: "S" }], callout: [{ title: "C" }] } } },
    ]);
    expect(outlineFromJson(source)).toBe("# Sheet 1\n\n- R\n  - A\n  - S\n  - C\n");
  });

  it("reads a long tag with no attributes in linear time", () => {
    const source = `<xmap-content><sheet><topic ${"x".repeat(400_000)}><title>T</title></topic></sheet></xmap-content>`;
    const started = performance.now();
    expect(outlineFromXml(source)).toBe("# Sheet 1\n\n- T\n");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("refuses a map with more topics or elements than it will hold in memory", () => {
    const topics = Array.from({ length: 100_001 }, () => ({ title: "a" }));
    expect(() => outlineFromJson(JSON.stringify([{ rootTopic: { children: { attached: topics } } }]))).toThrow("too many topics");
    expect(() => outlineFromXml("<a>".repeat(500_001))).toThrow("too many elements");
  });

  it("refuses content with no sheets", () => {
    expect(() => outlineFromJson("{}")).toThrow();
    expect(() => outlineFromXml("<html></html>")).toThrow();
  });
});

describe("saveXmindUpload", () => {
  it("stores the outline as Markdown, never the archive, and answers a retry with the same file", async () => {
    const before = scratchDirs();
    const members = [{ name: "metadata.json", data: "{}" }, { name: "content.json", data: CONTENT_JSON }, { name: "content.xml", data: "<stale/>" }];
    const saved = await saveXmindUpload(archive(members), "Plan.xmind", { uploadId: UPLOAD_ID });
    expect(saved).toMatchObject({ name: "Plan.xmind.md", mime: "text/markdown" });
    expect(basename(saved.path)).toBe(`${UPLOAD_ID}.md`);
    expect(readFileSync(saved.path, "utf8")).toBe(EXPECTED);
    expect((await saveXmindUpload(archive(members), "Plan.xmind", { uploadId: UPLOAD_ID })).path).toBe(saved.path);
    expect(scratchDirs()).toEqual(before);
  });

  it("reads a legacy archive that only has content.xml", async () => {
    const saved = await saveXmindUpload(archive([{ name: "content.xml", data: CONTENT_XML, method: 0 }]), "Old.xmind");
    expect(readFileSync(saved.path, "utf8")).toBe(EXPECTED);
  });

  it("answers 400 for anything that is not a readable mind map, and leaves nothing behind", async () => {
    const before = scratchDirs();
    const unreadable = { status: 400, message: "not a readable XMind file" };
    await expect(saveXmindUpload(body(Buffer.from("not a zip at all")), "a.xmind")).rejects.toMatchObject(unreadable);
    await expect(saveXmindUpload(archive([{ name: "notes.txt", data: "hi" }]), "a.xmind")).rejects.toMatchObject(unreadable);
    await expect(saveXmindUpload(archive([{ name: "content.json", data: "{ broken" }]), "a.xmind")).rejects.toMatchObject(unreadable);
    await expect(saveXmindUpload(archive([{ name: "content.json", data: "[]", declaredBytes: 32 * 1024 * 1024 + 1 }]), "a.xmind"))
      .rejects.toMatchObject(unreadable);
    await expect(saveXmindUpload(archive([{ name: "content.json", data: CONTENT_JSON, declaredBytes: 4 }]), "a.xmind"))
      .rejects.toMatchObject(unreadable);
    await expect(saveXmindUpload((async function* () {})(), "a.xmind")).rejects.toMatchObject({ status: 400, message: "empty file" });
    await expect(saveXmindUpload(archive([{ name: "content.json", data: CONTENT_JSON }]), "../a.xmind")).rejects.toMatchObject({ status: 400 });
    expect(scratchDirs()).toEqual(before);
  });
});
