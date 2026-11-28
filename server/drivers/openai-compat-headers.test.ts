import { describe, expect, it } from "vitest";

import {
  CustomHeaderError,
  CustomHeaderValidationError,
  customHeaderSecrets,
  decodeCustomHeaders,
  maskCustomSecrets,
  mergeCustomHeadersPatch,
  resolveCustomHeaders,
  scrubErrorSecrets,
  stripSensitiveCustomHeaders,
  summarizeCustomHeaders,
} from "./openai-compat-headers.ts";

describe("OpenAI-compatible custom headers config & resolution", () => {
  it("normalizes record and rule-array shapes and validates names, duplicates, protected headers, CR/LF, and variables", () => {
    expect(decodeCustomHeaders({
      enabled: true,
      headers: {
        "X-Maus-Thread-ID": "{threadId}",
        "X-Maus-Bot-ID": "{botId}",
        "X-Maus-Turn-ID": "{turnId}",
        "X-Provider": "{providerInstanceId}",
        "X-Gateway-Client": "maus",
      },
    })).toEqual({
      enabled: true,
      headers: [
        { name: "X-Maus-Thread-ID", value: "{threadId}", required: true, secret: false },
        { name: "X-Maus-Bot-ID", value: "{botId}", required: true, secret: false },
        { name: "X-Maus-Turn-ID", value: "{turnId}", required: true, secret: false },
        { name: "X-Provider", value: "{providerInstanceId}", required: true, secret: false },
        { name: "X-Gateway-Client", value: "maus", required: true, secret: false },
      ],
    });

    for (const badName of ["", "Bad Name", "X:Header", "X\r\nInject", "Authorization", "authorization", "Content-Type", "Proxy-Authorization", "Host", "Cookie", "Transfer-Encoding"]) {
      expect(() => decodeCustomHeaders({ enabled: true, headers: [{ name: badName, value: "ok" }] })).toThrow(CustomHeaderValidationError);
    }

    expect(() => decodeCustomHeaders({
      enabled: true,
      headers: [{ name: "X-Thread", value: "{threadId}" }, { name: "x-thread", value: "{botId}" }],
    })).toThrow(/duplicate/i);

    for (const badValue of ["", "   ", "val\r\nX-Inject: 1", "val\nnext", "val\0zero", "東京", "em—dash", "{unknownVar}", "prefix-{thredId}"]) {
      expect(() => decodeCustomHeaders({ enabled: true, headers: [{ name: "X-Ok", value: badValue }] })).toThrow(CustomHeaderValidationError);
    }
  });

  it("preserves disabled behavior, performs single-pass substitution, and handles required vs optional variables cleanly", () => {
    const off = decodeCustomHeaders({ enabled: false, headers: [{ name: "X-Maus-Thread-ID", value: "{threadId}" }] });
    expect(resolveCustomHeaders(off, {})).toEqual({});

    const on = decodeCustomHeaders({
      enabled: true,
      headers: [
        { name: "X-Maus-Thread-ID", value: "thread:{threadId}", required: true },
        { name: "X-Maus-Bot-ID", value: "{botId}", required: false },
        { name: "X-Maus-Turn-ID", value: "{turnId}", required: true },
        { name: "X-Provider-ID", value: "{providerInstanceId}" },
      ],
    });
    expect(resolveCustomHeaders(on, {
      threadId: "{botId}",
      turnId: "turn-1",
      providerInstanceId: "openai-compat-1",
    })).toEqual({
      "X-Maus-Thread-ID": "thread:{botId}",
      "X-Maus-Turn-ID": "turn-1",
      "X-Provider-ID": "openai-compat-1",
    });

    expect(() => resolveCustomHeaders(on, { turnId: "turn-1", providerInstanceId: "openai-compat-1" }))
      .toThrow(CustomHeaderError);
    expect(() => resolveCustomHeaders(on, { threadId: "t1\r\nInject: 1", turnId: "turn-1", providerInstanceId: "p1" }))
      .toThrow(CustomHeaderError);
    expect(() => resolveCustomHeaders(on, { threadId: "thr-東京", turnId: "turn-1", providerInstanceId: "p1" }))
      .toThrow(CustomHeaderError);
  });

  it("auto-detects sensitive headers, redacts summaries, preserves keepExisting secrets on patch, and collects log secrets", () => {
    const config = decodeCustomHeaders({
      enabled: true,
      headers: [
        { name: "X-Maus-Thread-ID", value: "{threadId}" },
        { name: "X-Gateway-Token", value: "gw-tok-secret-123456" },
        { name: "X-Tenant-Pin", value: "pin-987654", secret: true },
      ],
    });
    expect(summarizeCustomHeaders(config)).toEqual({
      enabled: true,
      headers: [
        { name: "X-Maus-Thread-ID", value: "{threadId}", configured: true, required: true, secret: false },
        { name: "X-Gateway-Token", configured: true, required: true, secret: true },
        { name: "X-Tenant-Pin", configured: true, required: true, secret: true },
      ],
    });
    expect(customHeaderSecrets(config, { threadId: "thr-1" })).toEqual([
      "gw-tok-secret-123456",
      "pin-987654",
    ]);

    const merged = mergeCustomHeadersPatch({
      enabled: true,
      headers: [
        { name: "X-Gateway-Token", keepExisting: true, secret: true },
        { name: "X-Maus-Thread-ID", value: "{threadId}" },
      ],
    }, config);
    expect(merged).toEqual({
      enabled: true,
      headers: [
        { name: "X-Gateway-Token", value: "gw-tok-secret-123456", required: true, secret: true },
        { name: "X-Maus-Thread-ID", value: "{threadId}", required: true, secret: false },
      ],
    });
    expect(() => mergeCustomHeadersPatch({
      enabled: true,
      headers: [{ name: "X-Missing-Secret", keepExisting: true, secret: true }],
    }, config)).toThrow(CustomHeaderValidationError);

    expect(() => mergeCustomHeadersPatch({
      enabled: true,
      headers: [{ name: "X-Tenant-Pin", keepExisting: true, secret: false }],
    }, config)).toThrow(CustomHeaderValidationError);

    const nonSecretBase = decodeCustomHeaders({
      enabled: true,
      headers: [{ name: "X-Env", value: "prod", secret: false }],
    });
    expect(mergeCustomHeadersPatch({
      enabled: true,
      headers: [{ name: "X-Env", keepExisting: true }],
    }, nonSecretBase)).toEqual({
      enabled: true,
      headers: [{ name: "X-Env", value: "prod", required: true, secret: false }],
    });

    const dynamicSecrets = decodeCustomHeaders({
      enabled: true,
      headers: [
        { name: "X-Short-Pin", value: "pass", secret: true },
        { name: "X-Templated-Secret", value: "tok-{threadId}", secret: true },
      ],
    });
    expect(customHeaderSecrets(dynamicSecrets, { threadId: "thread-99" })).toEqual(["tok-thread-99"]);
    expect(customHeaderSecrets(dynamicSecrets, { threadId: "1" })).toEqual([]);

    expect(mergeCustomHeadersPatch(
      { enabled: true, headers: [{ name: "X-Gateway-Token", keepExisting: true, secret: true }] },
      { enabled: true, headers: { "X-Gateway-Token": "gw-tok-map-123456" } },
    )).toEqual({
      enabled: true,
      headers: [{ name: "X-Gateway-Token", value: "gw-tok-map-123456", required: true, secret: true }],
    });
    expect(() => mergeCustomHeadersPatch({ enabled: true, headers: [] }, { enabled: "bad", headers: 123 })).toThrow(CustomHeaderValidationError);

    expect(stripSensitiveCustomHeaders(config)).toEqual({
      enabled: true,
      headers: [{ name: "X-Maus-Thread-ID", value: "{threadId}", required: true, secret: false }],
    });
    expect(stripSensitiveCustomHeaders(dynamicSecrets)).toBeUndefined();
    expect(maskCustomSecrets("err tok-thread-99", ["tok-thread-99"])).toBe("err [redacted]");
    const err = new Error("http 500: tok-thread-99");
    expect(scrubErrorSecrets(err, ["tok-thread-99"])).toBe(err);
    expect(err.message).toBe("http 500: [redacted]");
  });
});
