import { describe, expect, it, vi } from "vitest";

import {
  fetchGrokBotPackage,
  fetchGrokBotTemplate,
  GROK_BOT_INSTRUCTION_MAX_CHARS,
  GROK_BOT_RESPONSE_MAX_BYTES,
  GROK_BOT_TEMPLATE_ENDPOINT,
  GROK_BOT_TIMEOUT_MS,
  parseGrokBotUrl,
} from "./grok-bot-template.ts";

const shareId = "a".repeat(21);

function varint(value: number): number[] {
  const result: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    result.push(value ? byte | 0x80 : byte);
  } while (value);
  return result;
}

function fieldKey(field: number, wireType: number): number[] {
  return varint(field * 8 + wireType);
}

function fieldBytes(field: number, value: number[]): number[] {
  return [...fieldKey(field, 2), ...varint(value.length), ...value];
}

function text(field: number, value: string): number[] {
  return fieldBytes(field, [...new TextEncoder().encode(value)]);
}

function message(field: number, value: number[]): number[] {
  return fieldBytes(field, value);
}

function templateBytes(description = "Public instructions.", id = shareId, published = 1): number[] {
  return [
    ...text(1, id),
    ...text(2, "Public Grok Bot"),
    ...text(3, "orb"),
    ...text(4, "blue"),
    ...fieldKey(10, 0), ...varint(published),
    ...text(12, description),
  ];
}

function responseBytes(description = "Public instructions.", id = shareId, published = 1): Uint8Array {
  return new Uint8Array([
    ...message(1, templateBytes(description, id, published)),
    ...text(2, "Public owner"),
  ]);
}

function okResponse(bytes = responseBytes()): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "application/proto" } });
}

describe("public Grok Bot importer", () => {
  it("accepts only an exact public x.ai bot URL", () => {
    expect(parseGrokBotUrl(`https://x.ai/bot/${shareId}`)).toEqual({ id: shareId });
    const rejected = [
      `http://x.ai/bot/${shareId}`,
      `https://www.x.ai/bot/${shareId}`,
      `https://x.ai:443/bot/${shareId}`,
      `https://user:secret@x.ai/bot/${shareId}`,
      `https://x.ai/bot/${shareId}/`,
      `https://x.ai/bot/${shareId}?extra=1`,
      `https://x.ai/bot/${shareId}#fragment`,
      `https://x.ai/not-a-bot/${shareId}`,
      `https://x.ai/bot/${shareId.slice(0, -1)}`,
      `https://x.ai/bot/${shareId}/../private`,
    ];
    for (const value of rejected) expect(() => parseGrokBotUrl(value)).toThrow();

    try {
      parseGrokBotUrl("https://example.com/not-a-grok-bot");
      throw new Error("expected URL validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ status: 400, message: "Only exact public x.ai Grok Bot links are supported" });
    }
  });

  it("uses one anonymous protobuf request and maps the public profile to a package", async () => {
    let target = "";
    let init: RequestInit | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      target = String(url);
      init = options;
      return okResponse();
    }) as unknown as typeof fetch;

    const loaded = await fetchGrokBotPackage(`https://x.ai/bot/${shareId}`, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(target).toBe(GROK_BOT_TEMPLATE_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/proto", "connect-protocol-version": "1" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(GROK_BOT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(new Uint8Array([0x0a, 21, ...new TextEncoder().encode(shareId)]));
    expect(init?.headers).not.toHaveProperty("authorization");
    expect(init?.headers).not.toHaveProperty("cookie");
    expect(init?.headers).not.toHaveProperty("user-agent");

    expect(loaded.package.agents).toHaveLength(1);
    expect(loaded.package.agents[0]).toMatchObject({
      name: "Public Grok Bot",
      title: "Grok Bot",
      description: "Public instructions.",
      appearance: { color: "blue" },
    });
    expect(loaded.package.author.name).toBe("Public owner");
    expect(loaded.package.requirements).toEqual({ apps: [], capabilities: [] });
  });

  it("rejects malformed, truncated, duplicate, and oversized protobuf data", async () => {
    const unknown = [
      ...fieldKey(90, 0), ...varint(42),
      ...fieldKey(91, 1), 1, 2, 3, 4, 5, 6, 7, 8,
      ...fieldKey(92, 2), ...varint(3), 9, 8, 7,
      ...fieldKey(94, 3), ...fieldKey(1, 0), ...varint(1), ...fieldKey(94, 4),
    ];
    await expect(fetchGrokBotTemplate(`https://x.ai/bot/${shareId}`, async () =>
      okResponse(new Uint8Array([...message(1, [...unknown, ...templateBytes()]), ...text(2, "owner")])),
    )).resolves.toMatchObject({ template: { shareId, published: true } });

    const malformed = [
      new Uint8Array([0x0a, 0x80]),
      new Uint8Array([...message(1, templateBytes()).slice(0, -1), ...text(2, "owner")]),
      new Uint8Array([...message(1, [...fieldKey(1, 0), ...varint(1), ...templateBytes()]), ...text(2, "owner")]),
      new Uint8Array([...message(1, [...text(1, shareId), ...text(1, shareId), ...text(2, "name"), ...text(12, "instructions"), ...fieldKey(10, 0), 1]), ...text(2, "owner")]),
    ];
    for (const bytes of malformed) {
      await expect(fetchGrokBotTemplate(`https://x.ai/bot/${shareId}`, async () => okResponse(bytes))).rejects.toThrow("response is invalid");
    }

    const tooLarge = new Uint8Array(GROK_BOT_RESPONSE_MAX_BYTES + 1);
    await expect(fetchGrokBotTemplate(`https://x.ai/bot/${shareId}`, async () => okResponse(tooLarge))).rejects.toThrow("response is too large");
    await expect(fetchGrokBotTemplate(`https://x.ai/bot/${shareId}`, async () => new Response(new Uint8Array(), {
      status: 200,
      headers: { "content-length": String(GROK_BOT_RESPONSE_MAX_BYTES + 1) },
    }))).rejects.toThrow("response is too large");
  });

  it("bounds public instruction text and rejects unpublished or mismatched profiles", async () => {
    const url = `https://x.ai/bot/${shareId}`;
    const longDescription = "A".repeat(6_219);
    const loaded = await fetchGrokBotPackage(url, async () => okResponse(responseBytes(longDescription)));
    expect(loaded.package.agents[0]?.description).toBe(longDescription);
    expect(GROK_BOT_INSTRUCTION_MAX_CHARS).toBe(24_000);
    const threeByteDescription = "€".repeat(GROK_BOT_INSTRUCTION_MAX_CHARS);
    const threeByteLoaded = await fetchGrokBotPackage(url, async () => okResponse(responseBytes(threeByteDescription)));
    expect(threeByteLoaded.package.agents[0]?.description).toBe(threeByteDescription);
    const fourByteDescription = "😀".repeat(GROK_BOT_INSTRUCTION_MAX_CHARS / 2);
    const fourByteLoaded = await fetchGrokBotPackage(url, async () => okResponse(responseBytes(fourByteDescription)));
    expect(fourByteLoaded.package.agents[0]?.description).toBe(fourByteDescription);
    await expect(fetchGrokBotPackage(url, async () => okResponse(responseBytes("x", "other-share-id-12345")))).rejects.toThrow("response is invalid");
    await expect(fetchGrokBotPackage(url, async () => okResponse(responseBytes("instructions", shareId, 0)))).rejects.toThrow("profile is unpublished");
    await expect(fetchGrokBotPackage(url, async () => okResponse(responseBytes("   ")))).rejects.toThrow("instructions are empty");
    await expect(fetchGrokBotPackage(url, async () => okResponse(responseBytes("x".repeat(GROK_BOT_INSTRUCTION_MAX_CHARS + 1))))).rejects.toThrow("instructions are too large");
  });

  it("turns transport, redirect, and non-2xx failures into generic errors", async () => {
    const url = `https://x.ai/bot/${shareId}`;
    await expect(fetchGrokBotTemplate(url, async () => { throw new Error("redirect"); })).rejects.toThrow("request failed");
    await expect(fetchGrokBotTemplate(url, async () => new Response(null, { status: 503 }))).rejects.toThrow("request failed");
  });
});
