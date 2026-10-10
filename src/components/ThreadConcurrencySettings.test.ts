import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadConcurrencySettings } from "./ThreadConcurrencySettings";

const fixture = vi.hoisted(() => ({ limit: undefined as number | undefined }));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { config: { threads: fixture.limit === undefined ? undefined : { maxConcurrentPerBot: fixture.limit } } }, dispatch: vi.fn() }),
}));

describe("ThreadConcurrencySettings", () => {
  it("keeps three as the legacy default and offers one through ten", () => {
    fixture.limit = undefined;
    const markup = renderToStaticMarkup(createElement(ThreadConcurrencySettings));
    expect(markup).toContain('value="3" selected=""');
    expect(markup.match(/<option /g)).toHaveLength(10);
    expect(markup).toContain('value="10"');
    expect(markup).toContain("Extra messages queue until a slot opens.");
    expect(markup).toContain("Maximum running threads per bot");
  });
  it("shows the confirmed server value", () => {
    fixture.limit = 10;
    expect(renderToStaticMarkup(createElement(ThreadConcurrencySettings))).toContain('value="10" selected=""');
  });
});
