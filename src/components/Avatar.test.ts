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

const render = (props: Partial<MausAvatarProps>) =>
  renderToStaticMarkup(createElement(MausAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

describe("MausAvatar body", () => {
  it("keeps identity legible with a solid body and dark eyes, without a default mouth", () => {
    const markup = render({ color: "purple" });
    expect(markup.match(/stop-color="#8057C8"/g)).toHaveLength(3);
    expect(markup.match(/data-avatar-eye="[01]"[^>]*fill="#17211d"/g)).toHaveLength(2);
    expect(markup).not.toContain("stroke-linecap");
    expect(render({ showMouth: true })).toContain("stroke-linecap");
  });

  it("wears the cursor when no body is given", () => {
    expect(render({})).toContain(MASCOT_BODIES.cursor.fit);
  });

  it("wears the body it is given", () => {
    const markup = render({ bodyId: "star" });
    expect(markup).toContain(MASCOT_BODIES.star.fit);
  });

  it("falls back to the cursor for an unknown body", () => {
    // SAFETY: "hexagram" is deliberately not a valid MascotBodyId — this
    // exercises the runtime schema fallback for a value that could arrive
    // from persisted/streamed data, which the type system would otherwise
    // rule out at this call site.
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
  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
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
});

describe("resolveBotAvatarOutcome", () => {
  // `imageFailed` is set by the flat <img>'s own onError, which
  // renderToStaticMarkup never fires — there are no events in a static
  // render. The decision is a pure function precisely so this branch is
  // still testable synchronously.
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
