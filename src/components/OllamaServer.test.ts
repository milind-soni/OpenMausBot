import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OllamaStatus } from "../../shared/local-model";
import { KEY_CATALOG, keyMatches } from "./keys/key-catalog";
import { ollamaBaseUrl } from "./OllamaServer";
import { OllamaModels, ollamaShortStatus, ollamaStatusText, OllamaStatusLine, OLLAMA_PULL } from "./OllamaStatusLine";

const URL = "http://127.0.0.1:11434";
const status = (state: OllamaStatus["state"], extra: Partial<OllamaStatus> = {}): OllamaStatus => ({ state, url: URL, models: [], ...extra });

describe("the Ollama card's states", () => {
  it("says it runs, with how many models it has", () => {
    expect(ollamaStatusText(status("ready", { models: [{ name: "llama3.2:latest" }, { name: "qwen3:4b" }] }))).toEqual({
      ok: true, text: `Ollama is running at ${URL}. Pulled models: 2.`,
    });
  });

  it("gives the command that pulls a first model, or starts Ollama", () => {
    expect(ollamaStatusText(status("no-models"))).toEqual({ ok: false, text: expect.stringContaining("has no models yet"), command: OLLAMA_PULL });
    expect(ollamaStatusText(status("not-running"))).toEqual({ ok: false, text: expect.stringContaining("isn’t running"), command: "ollama serve" });
  });

  it("tells a timeout, an unknown host and another server apart", () => {
    expect(ollamaStatusText(status("unreachable", { problem: "timeout" })).text).toContain("didn’t answer in time");
    expect(ollamaStatusText(status("unreachable", { problem: "network" })).text).toContain("Can’t reach Ollama");
    expect(ollamaStatusText(status("unreachable", { problem: "not-ollama" })).text).toContain("it isn’t Ollama");
  });

  it("shows the command as one line to copy", () => {
    const markup = renderToStaticMarkup(createElement(OllamaStatusLine, { status: status("no-models") }));
    expect(markup).toContain('data-ollama-state="no-models"');
    expect(markup).toContain(`<code class="self-start rounded-md bg-inset px-2 py-1 font-mono text-[12px] leading-4 text-ink select-all">${OLLAMA_PULL}</code>`);
  });

  it("has a few words for the engine list", () => {
    expect(ollamaShortStatus(status("not-running"))).toBe("Not running");
    expect(ollamaShortStatus(status("no-models"))).toBe("No models yet");
    expect(ollamaShortStatus(status("unreachable", { problem: "timeout" }))).toBe("Can’t be reached");
  });

  it("lists the pulled models with their facts, for the engine's row", () => {
    const markup = renderToStaticMarkup(createElement(OllamaModels, { instance: { models: { default: "a", options: [
      { id: "a", label: "llama3.2:latest", custom: true, local: { bytes: 2_019_393_189, parameters: "3.2B", quantization: "Q4_K_M", tools: true } },
      { id: "b", label: "typed-by-hand", custom: true },
    ] } } }));
    expect(markup).toContain("llama3.2:latest");
    expect(markup).toContain("3.2B · Q4_K_M · 2 GB");
    expect(markup).not.toContain("typed-by-hand");
  });

  it("adds the OpenAI-compatible routes under /v1", () => {
    expect(ollamaBaseUrl(`${URL}/`)).toBe(`${URL}/v1`);
  });

  it("is what a search for Ollama finds in Connections", () => {
    expect(KEY_CATALOG.filter((entry) => keyMatches(entry, "ollama")).map((entry) => entry.id)[0]).toBe("ollama");
  });
});
