import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";

import { providerName } from "./EngineLibrary";
import { DeepSeekMark, PresetProviderMark, ProviderMark } from "./ProviderIcons";

describe("DeepSeek Harness in the renderer", () => {
  it("names DeepSeek as the provider behind the engine card", () => {
    expect(providerName({ driverKind: "deepseekAgent" } as InstanceInfo)).toBe("DeepSeek");
  });

  it("draws the DeepSeek whale for the deepseekAgent driver and the deepseek preset alike", () => {
    const own = renderToStaticMarkup(createElement(DeepSeekMark, { size: 20 }));
    expect(own).toContain("<svg");
    expect(own).toContain('width="20"');
    expect(renderToStaticMarkup(createElement(ProviderMark, { driverKind: "deepseekAgent", size: 20 }))).toBe(own);
    expect(renderToStaticMarkup(createElement(PresetProviderMark, { preset: "deepseek", size: 20 }))).toBe(own);
  });
});
