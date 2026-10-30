// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { ChatMarkdown } from "./ChatMarkdown";

// These are Advanced mode's per-block header controls; Simple mode's plate is tested in ChatMarkdown.test.ts.
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
  readAdvancedMode: () => true,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("individual Markdown block actions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.spyOn>;
  const plain = "  first line\n\n  second line\n";
  const code = 'const value = "a long value";\n  console.log(value);';
  const text = `Outside the blocks.\n\n\`\`\`text\n${plain}\n\`\`\`\n\nBetween the blocks.\n\n\`\`\`typescript\n${code}\n\`\`\``;

  beforeEach(async () => {
    setLocale("en");
    writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(ChatMarkdown, { text })));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const buttons = (host: HTMLElement, label: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`));

  it("copies only the chosen block, retaining indentation and deliberate blank lines", async () => {
    const [first, second] = buttons(host, "Copy code to clipboard");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    await act(async () => first!.click());
    expect(writeText).toHaveBeenLastCalledWith(plain);
    expect(first!.getAttribute("aria-label")).toBe("Code copied to clipboard");
    expect(second!.getAttribute("aria-label")).toBe("Copy code to clipboard");
    await act(async () => second!.click());
    expect(writeText).toHaveBeenLastCalledWith(code);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("wraps and unwraps one block without changing its neighbor or copied content", async () => {
    const [first, second] = buttons(host, "Wrap long lines");
    await act(async () => first!.click());
    expect(first!.getAttribute("aria-pressed")).toBe("true");
    expect(first!.getAttribute("aria-label")).toBe("Disable line wrapping");
    expect(second!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => buttons(host, "Copy code to clipboard")[0]!.click());
    expect(writeText).toHaveBeenLastCalledWith(plain);
    await act(async () => first!.click());
    expect(first!.getAttribute("aria-pressed")).toBe("false");
    expect(second!.getAttribute("aria-pressed")).toBe("false");
  });

  it("updates the existing live status on only that block and allows a successful retry", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    const [first, second] = buttons(host, "Copy code to clipboard");
    const status = first!.querySelector('[role="status"]');
    expect(status?.textContent).toBe("Copy");
    await act(async () => first!.click());
    expect(first!.getAttribute("aria-label")).toBe("Could not copy");
    expect(first!.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe("Could not copy");
    expect(second!.querySelector('[role="status"]')?.textContent).toBe("Copy");
    await act(async () => first!.click());
    expect(first!.getAttribute("aria-label")).toBe("Code copied to clipboard");
    expect(first!.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe("Copied");
    expect(writeText).toHaveBeenLastCalledWith(plain);
  });
});
