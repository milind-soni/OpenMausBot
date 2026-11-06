import { expect, it } from "vitest";
import { settleParkedFiles } from "./turn-attachments.ts";

const image = { kind: "image" as const, path: "/a/one.png", mime: "image/png" };
const note = { kind: "audio" as const, path: "/a/two.mp3", mime: "audio/mpeg", text: "  the token is sk-live-abc  " };
const redact = (text: string) => text.replace(/sk-live-\w+/, "[redacted]");

it("lands a failed turn's voice note with its images, its words kept as a redacted transcript", () => {
  expect(settleParkedFiles([image, note], false, redact)).toEqual({
    land: [image, { kind: "audio", path: "/a/two.mp3", mime: "audio/mpeg", text: "the token is [redacted]" }],
    discard: [],
  });
});

it("discards only the voice notes of a stopped turn", () => {
  expect(settleParkedFiles([image, note], true, redact)).toEqual({ land: [image], discard: [note] });
});

it("leaves no transcript on a note recorded without words", () => {
  expect(settleParkedFiles([{ ...note, text: "   " }], false, redact).land).toEqual([{ kind: "audio", path: "/a/two.mp3", mime: "audio/mpeg" }]);
});

it("discards a goal coordinator's images and keeps its voice notes", () => {
  expect(settleParkedFiles([image, note], false, redact, true)).toEqual({
    land: [{ kind: "audio", path: "/a/two.mp3", mime: "audio/mpeg", text: "the token is [redacted]" }],
    discard: [image],
  });
});
