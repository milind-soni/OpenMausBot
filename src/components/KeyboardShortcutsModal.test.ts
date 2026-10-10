import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SendKey } from "@/lib/send-key";

const fixture = vi.hoisted(() => ({ sendKey: "enter" as SendKey }));
vi.mock("@/lib/send-key", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/send-key")>(),
  useSendKey: () => fixture.sendKey,
}));

import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";

/** The keycaps drawn beside a row. */
function keys(html: string, description: string): string[] {
  const row = html.slice(html.indexOf(`>${description}</span>`)).split("</div>")[0]!;
  return [...row.matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)].map((match) => match[1]!);
}

describe("KeyboardShortcutsModal", () => {
  it("uses a labeled native dialog with search and dismiss controls", () => {
    const html = renderToStaticMarkup(createElement(KeyboardShortcutsModal, { open: true, onClose: vi.fn() }));
    expect(html).toContain('<dialog aria-labelledby="shortcuts-dialog-title"');
    expect(html).toContain('aria-label="Search shortcuts"');
    expect(html).toContain('aria-label="Close keyboard shortcuts"');
    expect(html).toContain("Done");
    expect(html).not.toContain("Double-click");
    expect(html).not.toContain("from anywhere");
  });

  it.each([
    ["enter", ["Enter"], ["Shift", "Enter"]],
    ["shift-enter", ["Shift", "Enter"], ["Enter"]],
    ["mod-enter", ["Ctrl", "Enter"], ["Enter"]],
  ] as const)("shows the send key chosen in Settings (%s)", (sendKey, send, newLine) => {
    fixture.sendKey = sendKey;
    const html = renderToStaticMarkup(createElement(KeyboardShortcutsModal, { open: true, onClose: vi.fn() }));
    expect(keys(html, "Send message")).toEqual(send);
    expect(keys(html, "Insert new line without sending")).toEqual(newLine);
    fixture.sendKey = "enter";
  });

  it("does not render when closed", () => {
    expect(renderToStaticMarkup(createElement(KeyboardShortcutsModal, { open: false, onClose: vi.fn() }))).toBe("");
  });
});
