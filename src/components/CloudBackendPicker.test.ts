import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CloudBackendPicker } from "./CloudBackendPicker";

describe("cloud provider picker", () => {
  it("offers Orgo with its official local mark and keeps unsupported engines disabled", () => {
    const html = renderToStaticMarkup(createElement(CloudBackendPicker, { value: "orgo", vpsSupported: true, onChange: vi.fn() }));
    expect(html).toContain("Orgo");
    expect(html).toContain('viewBox="0 0 487 443"');
    expect(html).toContain("Auto only reuses an existing one");
    expect(html).not.toContain("<img");
    const unavailable = renderToStaticMarkup(createElement(CloudBackendPicker, { value: "box", vpsSupported: false, onChange: vi.fn() }));
    expect(unavailable).toMatch(/disabled=""[^>]+title="Orgo requires a model provider with computer tools"/);
  });
});
