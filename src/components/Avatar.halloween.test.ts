import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/halloween-dress", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/halloween-dress")>(),
  useHalloweenDressed: () => true,
}));

import { FACE_BOX } from "../../shared/cursor-face-data";
import { customMascotOutlinePathData, type CustomMascotShape, type MascotProfile } from "../../shared/mascot-profile";
import { BotAvatar, type BotAvatarProps } from "./Avatar";

const customShape: CustomMascotShape = {
  id: "a".repeat(64),
  name: "Test bunny",
  outline: Array.from({ length: 48 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    return [FACE_BOX / 2 + Math.cos(angle) * 82, FACE_BOX / 2 + Math.sin(angle) * 90] as const;
  }),
  anchor: { x: FACE_BOX / 2, y: FACE_BOX / 2, scale: 0.5 },
};

const profile = (selected: MascotProfile["selected"]): MascotProfile => ({
  version: 1,
  shapes: [customShape],
  selected,
});

const render = (bot: Partial<BotAvatarProps["bot"]>) => renderToStaticMarkup(
  createElement(BotAvatar, { bot: { color: "blue", mascotBody: "cursor", ...bot }, animated: false }),
);

describe("BotAvatar with Halloween dressing", () => {
  it("keeps a selected custom outline instead of replacing it with the seasonal body", () => {
    const markup = render({
      avatarCrop: "mascot",
      mascotProfile: profile({ kind: "custom", shapeId: customShape.id }),
    });

    expect(markup).toContain('<path d="' + customMascotOutlinePathData(customShape.outline) + '"></path></clipPath>');
    expect(markup).not.toContain('data-carved-body="cat"');
  });

  it("keeps the seasonal body when a saved library has a builtin selected", () => {
    const markup = render({
      avatarCrop: "mascot",
      mascotProfile: profile({ kind: "builtin", bodyId: "cursor" }),
    });

    expect(markup).toContain('data-carved-body="cat"');
  });
});
