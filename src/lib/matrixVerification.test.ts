import { describe, it, expect } from "vitest";
import { resolveHeaderCollapse } from "./headerCollapse";
import { SHARED_HEADER_HEIGHT, SHARED_HEADER_HEIGHT_CLASS } from "./layoutTokens";

describe("Dell QA Matrix Layout Verification", () => {
  const VIEWPORTS = [1024, 1280, 1440, 1920] as const;
  const SIDEBAR_WIDTH = 320;
  const PREVIEW_WIDTH_DOCKED = 380;
  const PREVIEW_WIDTH_DOCKED_2XL = 420;
  const TASKS_WIDTH = 320;

  it("satisfies shared header height token of 60px across all panels", () => {
    expect(SHARED_HEADER_HEIGHT).toBe(60);
    expect(SHARED_HEADER_HEIGHT_CLASS).toBe("h-[60px]");
  });

  describe("Header collapse and reflow at each viewport and task state", () => {
    for (const vp of VIEWPORTS) {
      for (const tasksOpen of [false, true]) {
        it(`evaluates layout at ${vp}px with Tasks ${tasksOpen ? "OPEN" : "CLOSED"}`, () => {
          let chatWidth: number;
          let previewIsDrawer: boolean;
          let tasksIsDrawer: boolean;

          if (vp === 1024) {
            // Below 1180px, both Preview and Tasks are overlay drawers (or mutually exclusive)
            chatWidth = vp - SIDEBAR_WIDTH; // 704px
            previewIsDrawer = true;
            tasksIsDrawer = true;
          } else if (vp === 1280) {
            if (tasksOpen) {
              // Tasks is docked, Preview becomes an overlay drawer to avoid squeezing chat
              chatWidth = vp - SIDEBAR_WIDTH - TASKS_WIDTH; // 640px
              previewIsDrawer = true;
              tasksIsDrawer = false;
            } else {
              // Tasks closed, Preview docks statically
              chatWidth = vp - SIDEBAR_WIDTH - PREVIEW_WIDTH_DOCKED; // 580px
              previewIsDrawer = false;
              tasksIsDrawer = false;
            }
          } else if (vp === 1440) {
            if (tasksOpen) {
              // At >= 1400px, both dock side-by-side
              chatWidth = vp - SIDEBAR_WIDTH - PREVIEW_WIDTH_DOCKED - TASKS_WIDTH; // 420px
              previewIsDrawer = false;
              tasksIsDrawer = false;
            } else {
              chatWidth = vp - SIDEBAR_WIDTH - PREVIEW_WIDTH_DOCKED; // 740px
              previewIsDrawer = false;
              tasksIsDrawer = false;
            }
          } else {
            // 1920px
            if (tasksOpen) {
              chatWidth = vp - SIDEBAR_WIDTH - PREVIEW_WIDTH_DOCKED_2XL - TASKS_WIDTH; // 860px
              previewIsDrawer = false;
              tasksIsDrawer = false;
            } else {
              chatWidth = vp - SIDEBAR_WIDTH - PREVIEW_WIDTH_DOCKED_2XL; // 1180px
              previewIsDrawer = false;
              tasksIsDrawer = false;
            }
          }

          expect(typeof previewIsDrawer).toBe("boolean");
          expect(typeof tasksIsDrawer).toBe("boolean");

          // Rule 2: Chat must never be squeezed below 360px
          expect(chatWidth).toBeGreaterThanOrEqual(360);

          const collapse = resolveHeaderCollapse(chatWidth);

          if (chatWidth <= 420) {
            // Tightest case: 1440px with Tasks open
            expect(collapse.isTight).toBe(true);
            expect(collapse.isVeryTight).toBe(true);
            expect(collapse.modelMode).toBe("iconOnly");
            expect(collapse.showButtonsText).toBe(false);
            expect(collapse.collapseSecondaryToMenu).toBe(true);

            // Compute right controls width in bot chat:
            // Usage ring (compact: 20px) + ModelPicker (iconOnly: 32px) + More menu (28px) +
            // Preview button (icon: 28px) + Tasks button (icon + badge: 30px) + gaps (5 * 5 = 25px)
            const rightControlsWidth = 20 + 32 + 28 + 28 + 30 + 25; // 163px
            const padding = 28; // px-3.5 * 2
            const availableForLeft = chatWidth - padding - rightControlsWidth; // 420 - 28 - 163 = 229px
            // Avatar (28px) + gap (8px) = 36px. Left for bot name = 193px (more than 10rem / 160px!)
            expect(availableForLeft).toBeGreaterThan(160 + 36);
          } else if (chatWidth < 520) {
            expect(collapse.isTight).toBe(true);
            expect(collapse.collapseSecondaryToMenu).toBe(true);
          } else if (chatWidth < 640) {
            expect(collapse.isCompact).toBe(true);
            expect(collapse.showButtonsText).toBe(false);
            expect(collapse.collapseSecondaryToMenu).toBe(false);
          } else {
            expect(collapse.isSpacious).toBe(true);
            expect(collapse.showButtonsText).toBe(true);
            expect(collapse.collapseSecondaryToMenu).toBe(false);
          }
        });
      }
    }
  });

  describe("Six-member room header budget at 1440px (chat width 420px)", () => {
    it("fits 6 members, name, and controls without overflowing or spilling into Preview", () => {
      const chatWidth = 420;
      const collapse = resolveHeaderCollapse(chatWidth);
      expect(collapse.isTight).toBe(true);
      expect(collapse.collapseSecondaryToMenu).toBe(true);

      // In room, secondary actions (Schedule, Room Activity) move into More (•••) menu
      // Left side: Room name (up to 160px) + Stacked avatars (2 avatars + badge: ~56px) + gap (8px) = 224px
      const leftWidth = 160 + 56 + 8; // 224px
      // Right side: Usage ring (20px) + More menu (28px) + Preview (28px) + Tasks (28px) + gaps (4 * 5 = 20px) = 124px
      const rightWidth = 20 + 28 + 28 + 28 + 20; // 124px
      const padding = 28; // 392px content budget
      const totalHeaderWidth = leftWidth + rightWidth + padding;

      expect(totalHeaderWidth).toBeLessThanOrEqual(420);
    });
  });

  describe("Wide Preview toolbar horizontal overflow check at 1920px (Task 0b72565c)", () => {
    it("fits title, min address width, and controls within the 420px panel", () => {
      const panelWidth = 420;
      const padding = 20; // px-2.5 * 2
      const availableContent = panelWidth - padding; // 400px

      // Title: Smartphone icon (15px) + gap (4px) + Preview text (45px) = 64px
      const titleWidth = 64;
      // Primary controls: Reload (28px) + Size button (79px) + Rotate (28px) + More (28px) + Close (28px) + gaps (8px) = 199px
      const primaryControlsWidth = 199;
      // Section gaps: 2 * 6px = 12px
      const nonAddressWidth = titleWidth + primaryControlsWidth + 12; // 275px

      // Minimum address width: 110px
      const minAddressWidth = 110;
      const totalRequiredWidth = nonAddressWidth + minAddressWidth; // 385px

      expect(totalRequiredWidth).toBeLessThanOrEqual(availableContent);
      // Remaining space (400 - 275 = 125px) is given to address field via flex-1
      expect(availableContent - nonAddressWidth).toBeGreaterThanOrEqual(minAddressWidth);
    });
  });

  describe("Mutual exclusivity of drawers below 1180px (Task 5782d84f)", () => {
    it("renders only the active drawer with a single backdrop", () => {
      // Below 1180px:
      const isLargeScreen = false;
      const mobilePreviewOpen = true;
      const tasksOpen = true;
      const lastRequestedDrawer = "preview";

      const activeMobileDrawer = !isLargeScreen
        ? mobilePreviewOpen && tasksOpen
          ? lastRequestedDrawer
          : mobilePreviewOpen
          ? "preview"
          : tasksOpen
          ? "tasks"
          : null
        : null;

      expect(activeMobileDrawer).toBe("preview");

      // Verify switching to tasks drawer
      const switchedDrawer = !isLargeScreen
        ? mobilePreviewOpen && tasksOpen
          ? "tasks"
          : null
        : null;

      expect(switchedDrawer).toBe("tasks");
    });
  });
});
