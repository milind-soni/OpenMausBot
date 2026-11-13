import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeaderMoreMenu } from "@/components/HeaderMoreMenu";
import { resolveHeaderCollapse } from "./headerCollapse";

describe("Header reflow and collapse logic", () => {
  it("determines initial collapse state based on container width thresholds", () => {
    // Wide mode (>=640px)
    const wide = resolveHeaderCollapse(700);
    expect(wide.isSpacious).toBe(true);
    expect(wide.showButtonsText).toBe(true);
    expect(wide.modelMode).toBe("full");
    expect(wide.collapseSecondaryToMenu).toBe(false);

    // Compact mode (520px - 639px)
    const compact = resolveHeaderCollapse(580);
    expect(compact.isCompact).toBe(true);
    expect(compact.showButtonsText).toBe(false);
    expect(compact.modelMode).toBe("compact");
    expect(compact.collapseSecondaryToMenu).toBe(false);

    // Tight mode with More menu (<520px)
    const tight = resolveHeaderCollapse(480);
    expect(tight.isTight).toBe(true);
    expect(tight.collapseSecondaryToMenu).toBe(true);
    expect(tight.modelMode).toBe("compact");

    // Very tight mode (<=420px, e.g. 1440px with Preview + Tasks docked)
    const veryTight = resolveHeaderCollapse(420);
    expect(veryTight.isVeryTight).toBe(true);
    expect(veryTight.modelMode).toBe("iconOnly");
    expect(veryTight.collapseSecondaryToMenu).toBe(true);
  });

  it("HeaderMoreMenu renders with correct accessible roles and attributes", () => {
    const html = renderToStaticMarkup(
      createElement(HeaderMoreMenu, {
        items: [
          { id: "schedule", label: "Schedule run…", onClick: () => {} },
          { id: "computer", label: "Bot's computer", onClick: () => {} },
        ],
      }),
    );
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('aria-haspopup="menu"');
  });
});
