import { describe, expect, it, vi } from "vitest";

import { base64Bytes, EXTRACT_LIMITS, extractRequestProblem, relayAcceptsExtract } from "./contract.ts";
import { createExtractor } from "./index.ts";
import type { FieldSchema } from "./types.ts";

const fields: FieldSchema = { title: { type: "string" } };
const input = (data: string) => ({ images: [{ mime: "image/png" as const, data }] });

describe("base64 image input", () => {
  it.each(["A", "AAAAA", "=", "==", "A=", "A==", "AA=", "AAA==", "AAAA=", "AAAA==", "AAAAAA=", "AAAAAAA=="])(
    "rejects an incomplete encoding or misplaced padding: %s", async (data) => {
      expect(extractRequestProblem(fields, input(data))).toMatch(/data must be base64/);
      expect(relayAcceptsExtract("botExtract", fields, input(data))).toBe(false);
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ values: { title: "unexpected" } })));
      const extractor = createExtractor({
        config: () => ({ decider: { enabled: true, openrouterKey: "fixture-key" } }), fetch,
      });
      await expect(extractor.extract("botExtract", fields, input(data))).resolves.toEqual({ ok: false, reason: "misconfigured" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["YQ==", "YQ", "YWI=", "YWI", "YWJj", "YWJjZA==", "YWJjZA", "YWJjZGU=", "YWJjZGU"])(
    "keeps padded and unpadded encodings: %s", (data) => {
      expect(extractRequestProblem(fields, input(data))).toBeNull();
      expect(relayAcceptsExtract("botExtract", fields, input(data))).toBe(true);
      expect(base64Bytes(data)).toBe(Buffer.from(data, "base64").byteLength);
    },
  );

  it("keeps the decoded-byte cap for unpadded images", () => {
    const data = (size: number) => Buffer.alloc(size, 1).toString("base64").replace(/=+$/, "");
    expect(extractRequestProblem(fields, input(data(EXTRACT_LIMITS.imageBytes)))).toBeNull();
    expect(extractRequestProblem(fields, input(data(EXTRACT_LIMITS.imageBytes + 1)))).toMatch(/over 1 MB/);
  });
});
