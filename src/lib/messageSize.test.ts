import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BODY_CHARS, messageBodySize, messageTooLargeReason } from "./messageSize";

const image = (chars: number) => ({ id: "a1", name: "shot.png", mimeType: "image/png", size: chars, dataUrl: `data:image/png;base64,${"A".repeat(chars)}` });

describe("message size", () => {
  it("lets normal messages through", () => {
    expect(messageTooLargeReason("hello")).toBeNull();
    expect(messageTooLargeReason("x".repeat(MAX_MESSAGE_BODY_CHARS - 100))).toBeNull();
  });

  it("measures the body the server will read", () => {
    expect(messageBodySize("hi")).toBe(JSON.stringify({ text: "hi" }).length);
  });

  it("explains an oversized prompt", () => {
    const reason = messageTooLargeReason("x".repeat(2_000_000));
    expect(reason).toMatch(/too large to send \(2\.0 MB; the limit is 1\.0 MB\)/);
    expect(reason).toMatch(/Shorten it/);
  });

  it("counts attachment data and suggests removing it", () => {
    const reason = messageTooLargeReason("see screenshot", [image(1_200_000)]);
    expect(reason).toMatch(/Remove or shrink an attachment/);
  });
});
