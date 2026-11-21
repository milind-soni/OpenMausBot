// The what_changed tool's internal route: files from the bot's own folders or this conversation's attachments (the
// original side of the person's upload as it was sent, the edited side as it is now), text in place of a file, plain
// refusals, and the comparison run in a worker thread, one at a time, with the last answer kept for paging.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { keepUploadedOriginal, keptOriginalsDir } from "../attachment-originals.ts";
import { boxUploadsDir } from "../bot-box/plan.ts";
import { __forgetLastComparisonForTests, compareInWorker } from "../text-changes-worker.ts";
import { PASS } from "./table.ts";
import { conversationFileNames, createWhatChangedRoutes, WHAT_CHANGED_MESSAGES, WHAT_CHANGED_PATH, type WhatChangedDeps } from "./what-changed.ts";

const home = mkdtempSync(join(tmpdir(), "omb-what-changed-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const dataDir = join(home, "data"), store = join(dataDir, "attachments"), work = join(home, "work");
mkdirSync(store, { recursive: true });
mkdirSync(work);
const UPLOAD = "6f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.md", STRANGER = "7f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.md";
const ORIGINAL = "Mara walked into the bar at noon. The rain had not stopped.\n\nTom said nothing.";
const EDITED = "Mara ran into the bar at midnight. The rain had not stopped.\n\nTom said nothing. A stranger watched.";
const COUNTS = JSON.stringify({ changed: 1, added: 1, removed: 0, moved: 0, unchanged: 2 });
writeFileSync(join(store, UPLOAD), ORIGINAL);
writeFileSync(join(store, STRANGER), "not this conversation's");
writeFileSync(join(work, "chapter-edited.md"), EDITED);
writeFileSync(join(work, "chapter.docx"), "PK\u0003\u0004");
writeFileSync(join(work, "huge.txt"), "x".repeat(2 * 1024 * 1024 + 1));
writeFileSync(join(home, "elsewhere.md"), "not in the working folder");
const attachedText = (name: string) => `Improve the dialogue\n\n<attached-file path="${join(store, name)}" name="chapter.md" />`;

async function call(body: unknown, deps: Partial<WhatChangedDeps> = {}) {
  const route = createWhatChangedRoutes({ dataDir, attachmentsDir: store, messages: () => [{ text: attachedText(UPLOAD) }], compare: compareInWorker, ...deps });
  const json = vi.fn();
  const outcome = await route({ method: "POST", path: WHAT_CHANGED_PATH, res: {} as never, json, botId: "bot", threadId: "thread", readBody: async () => body, folders: async () => ({ roots: [work], vmWorkspace: null }) });
  const [, status, payload] = json.mock.calls[0] ?? [];
  return { outcome, status: status as number | undefined, payload: payload as { text?: string; error?: string } | undefined };
}

describe("what_changed route", () => {
  it("passes other paths on", async () => {
    const route = createWhatChangedRoutes({ dataDir, attachmentsDir: store, messages: () => [] });
    expect(await route({ method: "POST", path: "/api/internal/helpers/decide", res: {} as never, json: vi.fn(), botId: "b", threadId: "t", readBody: async () => ({}), folders: async () => ({ roots: [], vmWorkspace: null }) })).toBe(PASS);
  });

  it("compares the person's attachment with the bot's edit in its working folder, in a worker thread", async () => {
    const { status, payload } = await call({ original_file: join(store, UPLOAD), edited_file: join(work, "chapter-edited.md") });
    expect(status).toBe(200);
    expect(payload!.text!.split("\n")).toEqual([
      COUNTS,
      "1. changed, paragraph 1: Mara [-walked-]{+ran+} into the bar at [-noon-]{+midnight+}.",
      "2. added, paragraph 2: {+A stranger watched.+}",
      WHAT_CHANGED_MESSAGES.notKept,
    ]);
  });

  it("reads the attachment by the path a boxed turn was given", async () => {
    const boxed = join(boxUploadsDir(dataDir, "bot", "thread"), UPLOAD);
    const { status, payload } = await call({ original_file: boxed, edited_text: EDITED });
    expect(status).toBe(200);
    expect(payload!.text!.split("\n")[0]).toBe(COUNTS);
  });

  it("finds the bot's edit when it saved over the person's upload and passes that one path as both sides", async () => {
    const name = "8f1d2c3b-1a2b-4c3d-8e4f-0a1b2c3d4e5f.md", path = join(store, name);
    writeFileSync(path, ORIGINAL);
    await keepUploadedOriginal(path, keptOriginalsDir(dataDir));
    // The way an engine's atomic save replaces a file: a new file renamed over the old name.
    writeFileSync(`${path}.tmp`, EDITED);
    renameSync(`${path}.tmp`, path);
    const { status, payload } = await call({ original_file: path, edited_file: path }, { messages: () => [{ text: attachedText(name) }] });
    expect(status).toBe(200);
    expect(payload!.text!.split("\n")[0]).toBe(COUNTS);
    expect(payload!.text).not.toContain(WHAT_CHANGED_MESSAGES.notKept);
  });

  it("refuses a stored file this conversation does not carry, and files outside the bot's folders", async () => {
    expect(await call({ original_file: join(store, STRANGER), edited_text: "x" })).toMatchObject({ status: 403, payload: { error: WHAT_CHANGED_MESSAGES.outside } });
    expect(await call({ original_file: join(home, "elsewhere.md"), edited_text: "x" })).toMatchObject({ status: 403 });
  });

  it("says what is missing, what is not text and what is too large, in words a bot can act on", async () => {
    expect(await call({ original_text: "a" })).toMatchObject({ status: 400, payload: { error: WHAT_CHANGED_MESSAGES.sides } });
    expect(await call({ original_text: "a", original_file: join(work, "chapter-edited.md"), edited_text: "b" })).toMatchObject({ status: 400 });
    expect(await call({ original_file: join(work, "chapter.docx"), edited_text: "b" })).toMatchObject({ status: 415, payload: { error: WHAT_CHANGED_MESSAGES.notText } });
    expect(await call({ original_file: join(work, "huge.txt"), edited_text: "b" })).toMatchObject({ status: 413, payload: { error: WHAT_CHANGED_MESSAGES.tooLarge } });
    expect(await call({ original_text: "a", edited_text: "b" }, { compare: async () => ({ reason: "busy" }) })).toMatchObject({ status: 429, payload: { error: WHAT_CHANGED_MESSAGES.busy } });
    expect(await call({ original_text: "A. ".repeat(20_001), edited_text: "b" })).toMatchObject({ status: 413, payload: { error: WHAT_CHANGED_MESSAGES.tooManySentences } });
  });

  it("pages a long list from the last answer", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${i + 1}. added, paragraph ${i + 1}: {+x+}`);
    const compare = vi.fn(async () => ({ list: { head: "{}", lines, coarse: false } }));
    const page = (await call({ original_text: "a", edited_text: "b", start: 151 }, { compare })).payload!.text!.split("\n");
    expect(page[1]).toBe("151. added, paragraph 151: {+x+}");
    expect(page).toHaveLength(51);
  });
});

describe("compareInWorker", () => {
  it("runs one comparison at a time and answers a repeated one from the last answer", async () => {
    __forgetLastComparisonForTests();
    const first = compareInWorker(ORIGINAL, EDITED);
    expect(await compareInWorker("other", "texts")).toEqual({ reason: "busy" });
    const answer = await first;
    expect("list" in answer && answer.list.head).toBe(COUNTS);
    // A second page of the same pair, asked while another pair would be busy: no new comparison is started.
    const again = await Promise.all([compareInWorker(ORIGINAL, EDITED), compareInWorker(ORIGINAL, EDITED)]);
    expect(again).toEqual([answer, answer]);
  });
});

describe("conversationFileNames", () => {
  it("names the person's attachments and the bots' attached files, by stored name", () => {
    expect([...conversationFileNames([
      { text: `<attached-file path="/d/attachments/${UPLOAD}" name="a.md" />` },
      { text: "", attachments: [{ kind: "file", path: `/d/attachments/${STRANGER}` }, { kind: "image", path: "/d/attachments/x.png" }] },
    ])]).toEqual([UPLOAD, STRANGER]);
  });
});
