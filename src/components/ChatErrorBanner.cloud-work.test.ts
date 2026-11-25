// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { endCloudWork, setCloudWork } from "@/lib/cloud-work";
import { setLocale } from "@/lib/i18n";
import { ChatErrorBanner } from "./ChatErrorBanner";

// A send that failed while the Cloud was being updated is said calmly; once the Cloud is back, that line just goes away.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const MINUTE = 60_000;
let host: HTMLDivElement, root: Root | null = null;
const dismissed = vi.fn();

beforeEach(() => {
  setLocale("en");
  dismissed.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); endCloudWork(); });

/** The chat's own state around the line: its error, cleared by the line's dismiss. */
function Chat({ first }: { first: string }) {
  const [error, setError] = useState<string | null>(first);
  return createElement(ChatErrorBanner, { message: error, onDismiss: () => { dismissed(); setError(null); } });
}

describe("the calm chat line", () => {
  it("goes away when the Cloud is back, never turning into the red line", async () => {
    setCloudWork({ kind: "update", since: Date.now() - 40_000, until: Date.now() + 17 * MINUTE, expectedAt: Date.now() + 2 * MINUTE });
    await act(async () => root!.render(createElement(Chat, { first: "TypeError: Failed to fetch" })));
    expect(host.querySelector("[data-chat-cloud-work]")?.textContent).toContain("Updating My Cloud to the latest version.");
    await act(async () => endCloudWork());
    expect(host.querySelector("[data-chat-cloud-work]")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.innerHTML).not.toContain("text-danger");
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it("a send that failed with nothing of ours under way is the red line, as before", async () => {
    await act(async () => root!.render(createElement(Chat, { first: "TypeError: Failed to fetch" })));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(dismissed).not.toHaveBeenCalled();
  });
});
