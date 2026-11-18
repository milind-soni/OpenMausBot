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

  const switchOf = (markup: string, id: string) => markup.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))![0];

  it("keeps both knobs off by default, as switches, with no number to type until one is on", () => {
    fixture.threads = undefined;
    const markup = renderToStaticMarkup(createElement(ThreadCleanupSettings));
    expect(switchOf(markup, "thread-log-retention-enabled")).toContain('aria-checked="false"');
    expect(switchOf(markup, "thread-log-cap-enabled")).toContain('aria-checked="false"');
    expect(markup).not.toContain('id="thread-log-retention-days"');
    expect(markup).not.toContain('type="checkbox"');
    expect(markup.match(/Threads stay\./g)).toHaveLength(2);
  });

  it("shows the confirmed server values, cap converted from bytes to MiB", () => {
    fixture.threads = { maxConcurrentPerBot: 3, eventLogRetentionDays: 14, eventLogMaxBytes: 52428800 };
    const markup = renderToStaticMarkup(createElement(ThreadCleanupSettings));
    expect(switchOf(markup, "thread-log-retention-enabled")).toContain('aria-checked="true"');
    expect(switchOf(markup, "thread-log-cap-enabled")).toContain('aria-checked="true"');
    expect(markup).toContain('value="14"');
    expect(markup).toContain('value="50"');
  });

  it("renders a sub-megabyte cap as a fractional MiB value", () => {
    fixture.threads = { maxConcurrentPerBot: 3, eventLogMaxBytes: 262144 };
    const markup = renderToStaticMarkup(createElement(ThreadCleanupSettings));
    expect(switchOf(markup, "thread-log-cap-enabled")).toContain('aria-checked="true"');
    expect(markup).toContain('value="0.25"');
  });

  it("names both number inputs", () => {
    fixture.threads = { maxConcurrentPerBot: 3, eventLogRetentionDays: 7, eventLogMaxBytes: 1048576 };
    const markup = renderToStaticMarkup(createElement(ThreadCleanupSettings));
    expect(markup).toMatch(/id="thread-log-retention-days"[^>]*aria-label="Delete event logs of finished threads after"|aria-label="Delete event logs of finished threads after"[^>]*id="thread-log-retention-days"/);
    expect(markup).toContain('id="thread-log-cap-mib"');
  });
});
