import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  BotAvatar,
  NationAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type NationAvatarProps,
} from "./Avatar";

const render = (props: Partial<NationAvatarProps>) =>
  renderToStaticMarkup(createElement(NationAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

describe("NATION face frame", () => {
  it.each([undefined, "cursor", "star", "circle"] as const)("uses the NATION artwork for stored body %s", bodyId => {
    const markup = render({ bodyId });
    expect(markup).toContain("bot-faces/coordinator.png");
    expect(markup).toContain("object-contain");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("rounded-full");
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

  it("loads a stored image under the app's base, the only prefix that reaches the app", () => {
    vi.stubEnv("BASE_URL", "/swarm/");
    try {
      expect(renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" })).toContain('src="/swarm/api/attachments/cat.webp"');
      expect(renderBot({ avatarUrl: "/bot-faces/coordinator.svg", avatarCrop: "circle" })).toContain('src="/swarm/bot-faces/coordinator.svg"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("renders a soft-tower face image when the crop is mascot", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).toContain("<img");
    expect(markup).toContain("bot-faces/");
  });

  it("renders a soft-tower face image when there is no avatar URL", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).toContain("bot-faces/");
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
