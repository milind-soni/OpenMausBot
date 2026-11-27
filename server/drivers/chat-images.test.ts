import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertImageTransport, CHAT_IMAGE_BUDGET, chatImageBudget, chatImage, chatUserContent, UNREADABLE_CLIP_NOTE } from "./chat-images.ts";

describe("chat image transport and retained budget", () => {
  it("rejects encoded text and mismatched MIME claims while preserving a PNG", () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=";
    expect(chatImage({ mimeType: "image/png", data }).image_url.url).toBe(`data:image/png;base64,${data}`);
    expect(() => chatImage({ mimeType: "image/jpeg", data })).toThrow("MIME");
    expect(() => chatImage({ mimeType: "image/png", data: Buffer.from("not an image").toString("base64") })).toThrow("MIME");
  });
  it("counts input and successive screenshot batches against one budget", () => {
    const retain = chatImageBudget();
    const part = { type: "image_url" as const, image_url: { url: "x".repeat(CHAT_IMAGE_BUDGET / 2) } };
    retain([part]);
    retain("ordinary text");
    retain([part]);
    expect(() => retain([{ type: "image_url", image_url: { url: "x" } }])).toThrow("cannot be retained");
    expect(() => chatImageBudget()([part])).not.toThrow();
  });
  it.each(["https://api.example.com/v1", "http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"])("allows encrypted or loopback transport: %s", url => {
    expect(() => assertImageTransport(url)).not.toThrow();
  });
  it.each(["http://api.example.com/v1", "http://localhost.example.com/v1", "http://192.168.1.4/v1", "ftp://localhost/v1"])("refuses remote cleartext or unsupported transport: %s", url => {
    expect(() => assertImageTransport(url)).toThrow("require HTTPS");
  });
});

describe("chat user content with video clips", () => {
  it("still sends the turn when a clip was removed after it was attached, naming the gap", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-chat-clip-"));
    const kept = join(dir, "kept.mp4");
    writeFileSync(kept, Buffer.from("00000018667479706d703432", "hex"));
    try {
      const content = chatUserContent({ threadId: "t", text: "What happens here?", videos: [
        { path: join(dir, "gone.mp4"), mime: "video/mp4", bytes: 12 }, { path: kept, mime: "video/mp4", bytes: 12 },
      ] });
      expect(content).toEqual([
        { type: "text", text: "What happens here?" },
        { type: "text", text: UNREADABLE_CLIP_NOTE },
        { type: "image_url", image_url: { url: "data:video/mp4;base64,AAAAGGZ0eXBtcDQy" } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
