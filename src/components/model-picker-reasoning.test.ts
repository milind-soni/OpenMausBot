import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

const { variantLabel } = await import("./model-picker-reasoning");

afterEach(() => setLocale("en"));

describe("a thinking choice's words", () => {
  it("are the app's own on the chat engine, in the reader's language", () => {
    expect(variantLabel({ id: "on", label: "On" }, "openai-compat")).toBe("On");
    setLocale("pt-br");
    expect(variantLabel({ id: "on", label: "On" }, "openai-compat")).toBe("Ligado");
    expect(variantLabel({ id: "off", label: "Off" }, "openai-compat")).toBe("Desligado");
    expect(variantLabel({ id: "low", label: "Low" }, "openai-compat")).toBe("Baixo");
  });

  it("stay what the model calls them when it names its own, and on other engines", () => {
    setLocale("pt-br");
    expect(variantLabel({ id: "deep-dive", label: "Deep Dive" }, "openai-compat")).toBe("Deep Dive");
    expect(variantLabel({ id: "low", label: "Low" }, "copilotAgent")).toBe("Low");
  });
});
