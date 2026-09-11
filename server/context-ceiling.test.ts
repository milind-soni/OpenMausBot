import { describe, expect, it } from "vitest";

import { AUTO_COMPACT_AROUND_TOKENS } from "../shared/compact-around.ts";
import {
  COMPACTION_RATIO,
  advertisedWindowFor,
  contextCeiling,
  defaultWindow,
  envCeilingOverride,
  memoryPressure,
  probeMachine,
  probeMemory,
  ramTokenRoom,
  RAM_SAFETY_BYTES,
  KV_BYTES_PER_TOKEN,
  MIN_CONTEXT_WINDOW,
} from "./context-ceiling.ts";

describe("defaultWindow", () => {
  it("is conservative for local inject ids and generous for cloud slugs", () => {
    expect(defaultWindow("omlx::GLM-5.2-mxfp4")).toBe(8_192);
    expect(defaultWindow("grok-4.6")).toBe(128_000);
    expect(defaultWindow(undefined)).toBe(128_000);
  });
});

describe("contextCeiling", () => {
  it("prefers the advertised window when RAM is plentiful", () => {
    const ceiling = contextCeiling({
      advertisedWindow: 40_960,
      modelId: "ollama::qwen3:8b",
      memory: { totalBytes: 64 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 },
    });
    expect(ceiling).toEqual({ tokens: 40_960, source: "advertised" });
  });

  it("Auto ignores jumpy RAM and caps a huge advertised window at 128k", () => {
    const memory = { totalBytes: 8 * 1024 ** 3, freeBytes: RAM_SAFETY_BYTES + 2_048 * KV_BYTES_PER_TOKEN };
    const ceiling = contextCeiling({ advertisedWindow: 131_072, modelId: "omlx::big", memory });
    expect(ceiling).toEqual({ tokens: AUTO_COMPACT_AROUND_TOKENS, source: "compact" });
  });

  it("uses the local default when nothing is advertised", () => {
    const ceiling = contextCeiling({ modelId: "unsloth::Qwen3.8" });
    expect(ceiling).toEqual({ tokens: 8_192, source: "default" });
  });

  it("honors OPENMAUSBOT_CONTEXT_CEILING over everything else, including below the usual minimum", () => {
    const ceiling = contextCeiling({
      advertisedWindow: 131_072,
      modelId: "omlx::GLM-5.2-mxfp4",
      memory: { totalBytes: 64 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 },
      env: { OPENMAUSBOT_CONTEXT_CEILING: "12" },
    });
    expect(ceiling).toEqual({ tokens: 12, source: "override" });
  });

  it("never returns below the minimum window", () => {
    const ceiling = contextCeiling({
      advertisedWindow: 100,
      memory: { totalBytes: 1024, freeBytes: 10 },
    });
    expect(ceiling.tokens).toBe(MIN_CONTEXT_WINDOW);
  });
});

describe("ramTokenRoom", () => {
  it("subtracts the safety reserve before converting bytes to tokens", () => {
    const room = ramTokenRoom({ totalBytes: 16 * 1024 ** 3, freeBytes: RAM_SAFETY_BYTES + 10_000 * KV_BYTES_PER_TOKEN });
    expect(room).toBe(10_000);
  });
});

describe("memoryPressure", () => {
  it("is true when free RAM is under 1GB", () => {
    expect(memoryPressure({ totalBytes: 36 * 1024 ** 3, freeBytes: 512 * 1024 ** 2 })).toBe(true);
    expect(memoryPressure({ totalBytes: 36 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 })).toBe(false);
  });
});

describe("probeMemory", () => {
  it("reads the injected OS counters", () => {
    expect(probeMemory({ totalmem: () => 100, freemem: () => 40 })).toEqual({ totalBytes: 100, freeBytes: 40 });
  });
});

describe("advertisedWindowFor", () => {
  const catalog = {
    options: [
      { id: "grok-4.6" },
      { id: "ollama::qwen3:8b", contextWindow: 40_960 },
    ],
  };
  it("returns the catalog window for the selected id", () => {
    expect(advertisedWindowFor(catalog, "ollama::qwen3:8b")).toBe(40_960);
    expect(advertisedWindowFor(catalog, "grok-4.6")).toBeUndefined();
  });
});

describe("envCeilingOverride", () => {
  it("rejects junk", () => {
    expect(envCeilingOverride({ OPENMAUSBOT_CONTEXT_CEILING: "nope" })).toBeUndefined();
    expect(envCeilingOverride({ OPENMAUSBOT_CONTEXT_CEILING: "-1" })).toBeUndefined();
    expect(envCeilingOverride({ OPENMAUSBOT_CONTEXT_CEILING: "4096" })).toBe(4096);
  });
});

describe("COMPACTION_RATIO", () => {
  it("is 80%", () => {
    expect(COMPACTION_RATIO).toBe(0.8);
  });
});

const plentyRam = { totalBytes: 64 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 };

describe("Compact around", () => {
  it("Auto-caps a 256k advertised window at 128k so compact fires near 102k", () => {
    const ceiling = contextCeiling({
      advertisedWindow: 262_144,
      modelId: "unsloth::orcarouter/GLM-5.3-Flash-Uncensored-GGUF",
      memory: plentyRam,
    });
    expect(ceiling).toEqual({ tokens: AUTO_COMPACT_AROUND_TOKENS, source: "compact" });
    expect(ceiling.tokens * COMPACTION_RATIO).toBe(102_400);
  });

  it("does not raise a smaller advertised window", () => {
    const ceiling = contextCeiling({
      advertisedWindow: 40_960,
      modelId: "unsloth::Qwen3.8",
      memory: plentyRam,
    });
    expect(ceiling).toEqual({ tokens: 40_960, source: "advertised" });
  });

  it("Auto does not RAM-clamp a modest advertised window either", () => {
    const memory = { totalBytes: 8 * 1024 ** 3, freeBytes: RAM_SAFETY_BYTES + 2_048 * KV_BYTES_PER_TOKEN };
    const ceiling = contextCeiling({
      advertisedWindow: 40_960,
      modelId: "unsloth::Qwen3.8",
      memory,
    });
    expect(ceiling).toEqual({ tokens: 40_960, source: "advertised" });
  });

  it("honors a Compact around preset without raising advertised", () => {
    const capped = contextCeiling({
      advertisedWindow: 262_144,
      modelId: "unsloth::Qwen3.8",
      memory: plentyRam,
      compactAround: 64_000,
    });
    expect(capped).toEqual({ tokens: 64_000, source: "compact" });
    const untouched = contextCeiling({
      advertisedWindow: 40_960,
      modelId: "unsloth::Qwen3.8",
      memory: plentyRam,
      compactAround: 160_000,
    });
    expect(untouched).toEqual({ tokens: 40_960, source: "advertised" });
  });

  it("keeps a Compact around preset even when the RAM probe is tighter", () => {
    const memory = { totalBytes: 8 * 1024 ** 3, freeBytes: RAM_SAFETY_BYTES + 2_048 * KV_BYTES_PER_TOKEN };
    const ceiling = contextCeiling({
      advertisedWindow: 262_144,
      modelId: "unsloth::Qwen3.8",
      memory,
      compactAround: 32_000,
    });
    expect(ceiling).toEqual({ tokens: 32_000, source: "compact" });
  });

  it("uses the radio when local inject has no advertised window", () => {
    const ceiling = contextCeiling({
      modelId: "unsloth::orcarouter/GLM-5.3-Flash-Uncensored-GGUF",
      memory: { totalBytes: 8 * 1024 ** 3, freeBytes: RAM_SAFETY_BYTES + 2_048 * KV_BYTES_PER_TOKEN },
      compactAround: 32_000,
    });
    expect(ceiling).toEqual({ tokens: 32_000, source: "compact" });
  });

  it("does not override OPENMAUSBOT_CONTEXT_CEILING", () => {
    const ceiling = contextCeiling({
      advertisedWindow: 262_144,
      modelId: "unsloth::Qwen3.8",
      memory: plentyRam,
      compactAround: 64_000,
      env: { OPENMAUSBOT_CONTEXT_CEILING: "12" },
    });
    expect(ceiling).toEqual({ tokens: 12, source: "override" });
  });
});

describe("probeMachine", () => {
  it("reads injected counters", () => {
    expect(probeMachine({ totalmem: () => 99, cpuBrand: () => "Apple M3 Ultra" })).toEqual({
      totalBytes: 99,
      cpuBrand: "Apple M3 Ultra",
    });
  });
});
