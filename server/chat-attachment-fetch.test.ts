import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { fetchChatAttachment, listChatAttachments, type AttachmentFetchScope } from "./chat-attachment-fetch.ts";
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
