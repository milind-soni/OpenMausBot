import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPictureFiles, PICTURE_FILE_MAX_BYTES } from "./picture-file.ts";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("IHDR-rest-of-a-picture")]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00animated-frames", "latin1");
const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "g" };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(inConversation: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "picture-file-"));
  dirs.push(root);
  const workspace = join(root, "workspace"), attachments = join(root, "attachments"), elsewhere = join(root, "elsewhere");
  for (const dir of [workspace, attachments, elsewhere]) mkdirSync(dir);
  let saved = 0;
  const removed: string[] = [];
  const pictures = createPictureFiles({
    attachmentsDir: attachments,
    ownFolders: () => [workspace],
    inConversation: (_turn, name) => inConversation.includes(name),
    save: (bytes, mime) => {
      const path = join(attachments, `00000000-0000-4000-8000-00000000000${saved++}.${mime.split("/")[1]!.replace("jpeg", "jpg")}`);
      writeFileSync(path, bytes);
      return path;
    },
    remove: (path) => { removed.push(path); rmSync(path, { force: true }); },
  });
  return { pictures, workspace, attachments, elsewhere, removed };
}

const stored = (attachments: string, avatarUrl: string) => readFileSync(join(attachments, avatarUrl.slice("/api/attachments/".length)));

describe("a picture file a bot names", () => {
  it("copies a picture in the bot's workspace into the store, by absolute or relative path", async () => {
    const { pictures, workspace, attachments } = fixture();
    writeFileSync(join(workspace, "me.png"), PNG);
    const taken = await pictures.take(turn, join(workspace, "me.png"));
    expect(taken).toEqual({ avatarUrl: expect.stringMatching(/^\/api\/attachments\/[\w-]+\.png$/) });
    expect(stored(attachments, (taken as { avatarUrl: string }).avatarUrl).equals(PNG)).toBe(true);
    expect(await pictures.take(turn, "me.png")).toEqual({ avatarUrl: expect.stringMatching(/\.png$/) });
  });

  it("takes an animated GIF, and stores it by what its bytes are, not its name", async () => {
    const { pictures, workspace } = fixture();
    writeFileSync(join(workspace, "dance.gif"), GIF);
    writeFileSync(join(workspace, "really-a-png.txt"), PNG);
    expect(await pictures.take(turn, join(workspace, "dance.gif"))).toEqual({ avatarUrl: expect.stringMatching(/\.gif$/) });
    expect(await pictures.take(turn, join(workspace, "really-a-png.txt"))).toEqual({ avatarUrl: expect.stringMatching(/\.png$/) });
  });

  it("refuses a file whose bytes are not a PNG, JPEG, GIF or WebP, whatever its name says", async () => {
    const { pictures, workspace, attachments } = fixture();
    writeFileSync(join(workspace, "fake.png"), "<html><script>alert(1)</script></html>");
    writeFileSync(join(workspace, "drawing.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await pictures.take(turn, join(workspace, "fake.png"))).toEqual({ refusal: "fake.png is not a PNG, JPEG, GIF or WebP picture." });
    expect(await pictures.take(turn, join(workspace, "drawing.svg"))).toEqual({ refusal: "drawing.svg is not a PNG, JPEG, GIF or WebP picture." });
    expect(existsSync(join(attachments, "00000000-0000-4000-8000-000000000000.png"))).toBe(false);
  });

  it("refuses a file outside the bot's folders, by path, by .. or through a link", async () => {
    const { pictures, workspace, elsewhere } = fixture();
    writeFileSync(join(elsewhere, "secret.png"), PNG);
    symlinkSync(join(elsewhere, "secret.png"), join(workspace, "link.png"));
    for (const path of [join(elsewhere, "secret.png"), join(workspace, "..", "elsewhere", "secret.png"), "../elsewhere/secret.png", join(workspace, "link.png")]) {
      expect(await pictures.take(turn, path), path).toEqual({ refusal: expect.stringContaining("is outside your workspace") });
    }
  });

  it("takes a stored attachment only when this conversation carries it", async () => {
    const mine = "11111111-1111-4111-8111-111111111111.png", theirs = "22222222-2222-4222-8222-222222222222.png";
    const { pictures, attachments } = fixture([mine]);
    writeFileSync(join(attachments, mine), PNG);
    writeFileSync(join(attachments, theirs), PNG);
    expect(await pictures.take(turn, join(attachments, mine))).toEqual({ avatarUrl: expect.stringMatching(/\.png$/) });
    expect(await pictures.take(turn, join(attachments, theirs))).toEqual({ refusal: expect.stringContaining("is outside your workspace") });
  });

  it("refuses a picture over the size cap and a missing file", async () => {
    const { pictures, workspace } = fixture();
    writeFileSync(join(workspace, "huge.png"), Buffer.concat([PNG, Buffer.alloc(PICTURE_FILE_MAX_BYTES)]));
    expect(await pictures.take(turn, join(workspace, "huge.png"))).toEqual({ refusal: "That file is over 5 MB. Use a smaller picture." });
    expect(await pictures.take(turn, join(workspace, "gone.png"))).toEqual({ refusal: expect.stringMatching(/^No file was found at /) });
  });

  it("discard takes back the stored copy", async () => {
    const { pictures, workspace, attachments, removed } = fixture();
    writeFileSync(join(workspace, "me.png"), PNG);
    const taken = await pictures.take(turn, join(workspace, "me.png")) as { avatarUrl: string };
    pictures.discard(taken.avatarUrl);
    expect(removed).toEqual([join(attachments, taken.avatarUrl.slice("/api/attachments/".length))]);
  });
});
