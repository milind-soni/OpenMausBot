import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, statSync, rmSync, linkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { collectChatAttachments, fetchChatAttachment, listChatAttachments, type AttachmentFetchScope } from "./chat-attachment-fetch.ts";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "attachment-fetch-")); scratch.push(root);
  const store = join(root, "store"), workspace = join(root, "workspace"); mkdirSync(store); mkdirSync(workspace);
  const ref = "12345678-1234-4234-8234-123456789abc.png", path = join(store, ref);
  writeFileSync(path, "image bytes", { mode: 0o600 });
  const scope: AttachmentFetchScope = { attachmentStore: store, workspace, guestRoot: "/home/cua/workspace", botId: "bot-a", threadId: "thread-a", maxBytes: 1000, attachments: [{ path, mime: "image/png", name: "图片.png" }] };
  return { root, ref, scope, path };
}
it.skipIf(process.platform !== "linux")("copies into a readable default folder, reuses identical bytes, and preserves edited copies", () => {
  const { scope, ref, path } = fixture();
  const a = fetchChatAttachment(scope, ref);
  expect(a).toMatchObject({ name: "图片.png", reused: false, size: 11 });
  const local = join(scope.workspace, "attachments/inbox/bot-a/thread-a", ref);
  expect(a.local_path).toBe(`/home/cua/workspace/attachments/inbox/bot-a/thread-a/${ref}`);
  expect(statSync(local).mode & 0o777).toBe(0o644);
  expect(statSync(local).ino).not.toBe(statSync(path).ino);
  expect(fetchChatAttachment(scope, ref).reused).toBe(true);
  writeFileSync(local, "edited");
  const b = fetchChatAttachment(scope, ref);
  expect(b.reused).toBe(false); expect(b.local_path).not.toBe(a.local_path);
  expect(readFileSync(local, "utf8")).toBe("edited"); expect(readFileSync(path, "utf8")).toBe("image bytes");
});
it.skipIf(process.platform !== "linux")("supports relative destination directories and denies traversal, symlinks and foreign attachments", () => {
  const { scope, ref, root } = fixture();
  expect(fetchChatAttachment(scope, ref, "wechat-communication/files").local_path).toBe(`/home/cua/workspace/wechat-communication/files/${ref}`);
  for (const dir of ["/tmp", "../escape", "a/../../outside", "a\\..\\b", "C:/tmp", "", "a//b"]) expect(() => fetchChatAttachment(scope, ref, dir)).toThrow();
  mkdirSync(join(root, "outside")); symlinkSync(join(root, "outside"), join(scope.workspace, "link"));
  expect(() => fetchChatAttachment(scope, ref, "link/new")).toThrow();
  expect(() => fetchChatAttachment({ ...scope, attachments: [] }, ref)).toThrow("not available");
  expect(() => fetchChatAttachment(scope, "../" + ref)).toThrow();
  symlinkSync(join(scope.attachmentStore, ref), join(scope.attachmentStore, "link.png"));
  expect(listChatAttachments(scope.attachmentStore, [{ path: join(scope.attachmentStore, "link.png"), mime: "image/png" }])).toEqual([]);
});
it.skipIf(process.platform !== "linux")("checks size and produces isolated default destinations for different conversations", () => {
  const { scope, ref } = fixture();
  expect(() => fetchChatAttachment({ ...scope, maxBytes: 1 }, ref)).toThrow("size limit");
  expect(fetchChatAttachment({ ...scope, threadId: "other" }, ref).local_path).toContain("/bot-a/other/");
});

it.skipIf(process.platform !== "linux").each(["a".repeat(237) + ".png", "a." + "x".repeat(239)])("bounds collision filenames for %s", (ref) => {
  const { scope } = fixture();
  const path = join(scope.attachmentStore, ref);
  writeFileSync(path, "original");
  scope.attachments = [{ path, mime: "image/png" }];
  const first = fetchChatAttachment(scope, ref);
  expect(basename(first.local_path)).toBe(ref);
  expect(fetchChatAttachment(scope, ref).reused).toBe(true);
  const local = join(scope.workspace, "attachments/inbox/bot-a/thread-a", ref);
  writeFileSync(local, "edited");
  vi.mocked(linkSync).mockImplementationOnce((_source, destination) => {
    writeFileSync(destination, "concurrent file");
    throw Object.assign(new Error("already exists"), { code: "EEXIST" });
  });
  const copy = fetchChatAttachment(scope, ref);
  const name = basename(copy.local_path);
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
  expect(copy.reused).toBe(false);
  expect(readFileSync(join(scope.workspace, "attachments/inbox/bot-a/thread-a", name), "utf8")).toBe("original");
  expect(readFileSync(local, "utf8")).toBe("edited");
  expect(readFileSync(path, "utf8")).toBe("original");
});

it.skipIf(process.platform !== "linux")("lists and exports text-tag attachments while retaining audio and parked files", () => {
  const { scope, root } = fixture();
  const pdf = join(scope.attachmentStore, "calendar.pdf"), image = join(scope.attachmentStore, "calendar.png");
  const audio = join(scope.attachmentStore, "voice.mp3"), parked = join(scope.attachmentStore, "generated.png");
  const outside = join(root, "outside.pdf"), hidden = join(scope.attachmentStore, "hidden.pdf");
  for (const path of [pdf, image, audio, parked, outside, hidden]) writeFileSync(path, "fixture bytes");
  scope.attachments = collectChatAttachments([
    { role: "user", text: `<attached-file path="${pdf}" name="agenda.pdf" />\n<attached-image path="${image}" name="photo.png" />\n<attached-file path="${outside}" name="outside.pdf" />` },
    { role: "bot", text: "", attachments: [{ kind: "audio", path: audio, mime: "audio/mpeg" }] },
    { role: "bot", text: `<attached-file path="${hidden}" name="hidden.pdf" />` },
  ], [{ path: parked, mime: "image/png" }]);
  const files = listChatAttachments(scope.attachmentStore, scope.attachments);
  expect(files.map((file) => file.attachment_ref).sort()).toEqual(["calendar.pdf", "calendar.png", "generated.png", "voice.mp3"]);
  expect(files.find((file) => file.attachment_ref === "calendar.pdf")).toMatchObject({ name: "agenda.pdf", mime: "application/pdf" });
  expect(files.find((file) => file.attachment_ref === "calendar.png")?.mime).toBe("image/png");
  expect(files.find((file) => file.attachment_ref === "voice.mp3")?.mime).toBe("audio/mpeg");
  expect(fetchChatAttachment(scope, "calendar.pdf").local_path).toContain("calendar.pdf");
  expect(() => fetchChatAttachment(scope, "outside.pdf")).toThrow("not available");
  expect(() => fetchChatAttachment(scope, "hidden.pdf")).toThrow("not available");
});
