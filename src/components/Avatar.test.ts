import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  MausAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type MausAvatarProps,
} from "./Avatar";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";
import { FACE_BOX } from "../../shared/cursor-face-data";
import { customMascotOutlinePathData, type CustomMascotShape } from "../../shared/mascot-profile";

const customShape: CustomMascotShape = {
  id: "a".repeat(64),
  name: "Test bunny",
  outline: Array.from({ length: 48 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    return [FACE_BOX / 2 + Math.cos(angle) * 82, FACE_BOX / 2 + Math.sin(angle) * 90] as const;
  }),
  anchor: { x: FACE_BOX / 2, y: FACE_BOX / 2, scale: 0.5 },
};

const render = (props: Partial<MausAvatarProps>) =>
  renderToStaticMarkup(createElement(MausAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

describe("MausAvatar body", () => {
  it("wears the cursor when no body is given", () => {
    expect(render({})).toContain(MASCOT_BODIES.cursor.fit);
  });

  it("wears the body it is given", () => {
    const markup = render({ bodyId: "star" });
    expect(markup).toContain(MASCOT_BODIES.star.fit);
  });

  it("falls back to the cursor for an unknown body", () => {
    // SAFETY: "hexagram" is deliberately not a MascotBodyId, to exercise the runtime fallback for persisted or streamed
    // data.
    expect(render({ bodyId: "hexagram" as MausAvatarProps["bodyId"] })).toContain(
      MASCOT_BODIES.cursor.fit,
    );
  });

  it("paints the body with the per-bot gradient, never a flat black fill", () => {
    const markup = render({ bodyId: "circle" });
    expect(markup).not.toContain('fill="#000000"');
    expect(markup).not.toContain("{{GRADIENT}}");
    expect(markup).toContain("url(#");
  });
});

describe("BotAvatar's two avatar outcomes", () => {
  it("zooms and positions a custom image inside its crop", () => {
    const markup = renderBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 2,
      avatarFocusX: 0.25,
      avatarFocusY: 0.75,
    });
    expect(markup).toContain("scale(2)");
    expect(markup).toContain("25% 75%");
    expect(markup).toContain("border-radius:50%");
  });

  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
    expect(markup).toContain("border-radius:0");
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("radialGradient");
  });

  it("renders the gradient mascot when the crop is mascot, image or not", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });

  it("falls back to the gradient mascot when a flat crop has no valid image", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });

  it("renders a selected custom outline through the native face and gradient renderer", () => {
    const markup = renderBot({
      avatarCrop: "mascot",
      mascotBody: "cursor",
      mascotProfile: {
        version: 1,
        shapes: [customShape],
        selected: { kind: "custom", shapeId: customShape.id },
      },
    });
    const path = customMascotOutlinePathData(customShape.outline);

    expect(markup).toContain("<clipPath id=");
    expect(markup).toContain(`<path d="${path}"></path></clipPath>`);
    expect(markup).toContain(`<path d="${path}" fill="url(#`);
    expect(markup).toContain("<linearGradient id=");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("<rect");
  });
});

describe("resolveBotAvatarOutcome", () => {
  // imageFailed is set by the <img>'s onError, which renderToStaticMarkup never fires, so the decision is a pure
  // function.
  it("falls back to the gradient mascot for an image that failed to load", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "circle", hasUrl: true, imageFailed: true }),
    ).toBe("gradientMascot");
  });

  it("renders a good flat image flat", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "rounded", hasUrl: true, imageFailed: false }),
    ).toBe("flatImage");
  });

  it("keeps the mascot crop on the gradient mascot even with a loaded image", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "mascot", hasUrl: true, imageFailed: false }),
    ).toBe("gradientMascot");
  });

  it("falls back to the gradient mascot when there is no image at all", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "square", hasUrl: false, imageFailed: false }),
    ).toBe("gradientMascot");
  });
});
