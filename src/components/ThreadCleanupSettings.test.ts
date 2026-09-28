import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadCleanupSettings, parseCapMib } from "./ThreadCleanupSettings";

const fixture = vi.hoisted(() => ({
  threads: undefined as { maxConcurrentPerBot: number; eventLogMaxBytes?: number; eventLogRetentionDays?: number } | undefined,
}));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { config: fixture.threads === undefined ? {} : { threads: fixture.threads } }, dispatch: vi.fn() }),
}));

describe("ThreadCleanupSettings", () => {
  it("rejects cap values that are not exact 0.25 MiB steps", () => {
    expect(parseCapMib("0.25")).toBe(256 * 1024);
    expect(parseCapMib("1.5")).toBe(1536 * 1024);
    expect(parseCapMib("50")).toBe(50 * 1024 * 1024);
    expect(parseCapMib("0.251")).toBeNull();
    expect(parseCapMib("0.3")).toBeNull();
  });

  it("keeps both knobs off by default and disables their number entry", () => {
    fixture.threads = undefined;
    const markup = renderToStaticMarkup(createElement(ThreadCleanupSettings));
    expect(markup).not.toContain('thread-log-retention-enabled" type="checkbox" class="size-4 accent-accent" checked');
    expect(markup).not.toContain('thread-log-cap-enabled" type="checkbox" class="size-4 accent-accent" checked');
    expect(markup).toContain('id="thread-log-retention-days"');
    expect(markup).toContain('value="30"');
    expect(markup).toContain('value="50"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Off by default.");
    expect(markup.match(/never threads or transcripts\./g)).toHaveLength(2);
  });

  it("shows the confirmed server values, cap converted from bytes to MiB", () => {
    fixture.threads = { maxConcurrentPerBot: 3, eventLogRetentionDays: 14, eventLogMaxBytes: 52428800 };
    const markup = renderToStaticMarkup(createElement(ThreadCleanupSettings));
    expect(markup).toContain('id="thread-log-retention-enabled" type="checkbox" class="size-4 accent-accent" checked=""');
    expect(markup).toContain('id="thread-log-cap-enabled" type="checkbox" class="size-4 accent-accent" checked=""');
    expect(markup).toContain('value="14"');
    expect(markup).toContain('value="50"');
  });

  it("renders a sub-megabyte cap as a fractional MiB value", () => {
    fixture.threads = { maxConcurrentPerBot: 3, eventLogMaxBytes: 262144 };
    const markup = renderToStaticMarkup(createElement(ThreadCleanupSettings));
    expect(markup).toContain('id="thread-log-cap-enabled" type="checkbox" class="size-4 accent-accent" checked=""');
    expect(markup).toContain('value="0.25"');
  });

  it("wires both number inputs to their help copy", () => {
    fixture.threads = { maxConcurrentPerBot: 3, eventLogRetentionDays: 7, eventLogMaxBytes: 1048576 };
    const markup = renderToStaticMarkup(createElement(ThreadCleanupSettings));
    expect(markup).toContain('aria-describedby="thread-log-retention-help"');
    expect(markup).toContain('aria-describedby="thread-log-cap-help"');
    expect(markup).toContain('id="thread-log-retention-help"');
    expect(markup).toContain('id="thread-log-cap-help"');
  });
});
