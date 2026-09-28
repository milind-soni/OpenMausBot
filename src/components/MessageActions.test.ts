import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageActions } from "./MessageActions";

type Props = Parameters<typeof MessageActions>[0];

const render = (props: Partial<Omit<Props, "children">> = {}) =>
  renderToStaticMarkup(
    createElement(MessageActions, {
      side: "bot",
      ...props,
      children: [
        createElement("button", { type: "button", key: "copy" }, "copy"),
        createElement("button", { type: "button", key: "reply" }, "reply"),
      ],
    }),
  );

describe("MessageActions", () => {
  it("shows one collapsed handle with the controls tucked into a zero-width tray", () => {
    const html = render();
    expect(html).toContain('aria-label="Message actions"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("grid-cols-[0fr]");
    expect(html).toContain("group-hover/actions:grid-cols-[1fr]");
    expect(html).toContain(">copy<");
    expect(html).toContain(">reply<");
    expect(html).not.toContain('data-open="true"');
  });

  it("stays open while a control must remain reachable", () => {
    const html = render({ forceOpen: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-open="true"');
    expect(html).toContain("grid-cols-[1fr]");
    expect(html).not.toContain("grid-cols-[0fr]");
  });

  it("mirrors the tray on the user side so it slides away from the bubble", () => {
    expect(render({ side: "user" })).toContain("flex-row-reverse");
    expect(render({ side: "bot" })).not.toContain("flex-row-reverse");
  });
});
