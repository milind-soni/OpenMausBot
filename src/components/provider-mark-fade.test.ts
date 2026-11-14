import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PROVIDER_ICON_PRESETS } from "../../shared/provider-icon";
import { FADED_PROVIDER_MARK, providerMarkTone } from "./provider-mark-fade";
import { InstanceProviderMark, PresetProviderMark, ProviderMark } from "./ProviderIcons";

const source = readFileSync(join(process.cwd(), "src", "components", "ProviderIcons.tsx"), "utf8");
const driverSwitch = source.slice(source.indexOf("export function ProviderMark("), source.indexOf("export function PresetProviderMark("));
const DRIVERS = [...[...driverSwitch.matchAll(/case "([^"]+)":/g)].map((match) => match[1]!), "anEngineWithNoMark"];
const coloured = (html: string) => /#[0-9a-f]{3,8}\b|url\(#/i.test(html);

describe("the faded provider mark", () => {
  it("finds every engine the mark switch draws", () => {
    expect(DRIVERS.length).toBeGreaterThan(15);
    expect(DRIVERS).toContain("claudeAgent");
    expect(DRIVERS).toContain("codex");
  });

  it.each(DRIVERS)("treats %s as a brand-coloured mark exactly when its logo carries its own colours", (driverKind) => {
    const html = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 14 }));
    expect(providerMarkTone({ driverKind })).toBe(coloured(html) ? "brand" : "mono");
  });

  it.each([...PROVIDER_ICON_PRESETS])("treats the %s preset logo as brand-coloured exactly when it carries its own colours", (preset) => {
    const html = renderToStaticMarkup(createElement(PresetProviderMark, { preset, size: 14 }));
    expect(providerMarkTone({ driverKind: "codex", icon: { kind: "preset", preset } })).toBe(coloured(html) ? "brand" : "mono");
  });

  it("treats an engine's own picture as brand-coloured", () => {
    expect(providerMarkTone({ driverKind: "codex", icon: { kind: "custom", dataUrl: "data:image/png;base64,AA==" } })).toBe("brand");
  });

  it("dims a brand mark to 60% and inks a monochrome one in tertiary, both full again on hover", () => {
    const claude = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: { driverKind: "claudeAgent" }, size: 14, subtle: true }));
    expect(claude).toMatch(/^<span data-provider-mark="brand" class="[^"]*\bopacity-60\b[^"]*\bgroup-hover:opacity-100\b/);
    expect(claude).toContain("group-focus-within:opacity-100 touch:opacity-60");
    expect(claude).toContain('style="width:14px;height:14px"');
    const codex = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: { driverKind: "codex" }, size: 14, subtle: true }));
    expect(codex).toContain('data-provider-mark="mono"');
    expect(codex).toContain("[--color-ink:var(--color-ink-tertiary)]");
    expect(codex).toContain("group-hover:[--color-ink:inherit]");
    expect(codex).toContain("group-focus-within:[--color-ink:inherit]");
    expect(codex).not.toContain("opacity-60");
    expect(FADED_PROVIDER_MARK.mono).not.toContain("opacity");
  });

  it("leaves the full-strength mark alone without subtle", () => {
    const html = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: { driverKind: "claudeAgent" }, size: 14 }));
    expect(html).toMatch(/^<svg/);
    expect(html).not.toContain("data-provider-mark");
  });
});
