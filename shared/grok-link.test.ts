import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { GROK_EXPORT_MAX_CHARS } from "./grok-import.ts";
import { fromDesktopSchema, GROK_LINK_BODY_MAX, GROK_LINK_MCP_PATH, GROK_LINK_PATH_PREFIX, isLinkSecret, linkKey, toDesktopSchema, type LinkSecret } from "./grok-link.ts";

const SECRET = "A".repeat(43) as LinkSecret;
const result = { content: [{ type: "text", text: "said" }] };
const manifest = { versions: ["2025-06-18"], initialize: {}, tools: { tools: [] }, offline: { ...result, isError: true }, late: { ...result, isError: true } };

describe("the Grok Bot link's wire", () => {
  it("derives the address key from the secret, the same every time, in the shape the address takes", async () => {
    const key = await linkKey(SECRET);
    expect(key).toBe(createHash("sha256").update(`grok-link:${SECRET}`).digest("base64url"));
    expect(await linkKey(SECRET)).toBe(key);
    expect(await linkKey(`B${SECRET.slice(1)}` as LinkSecret)).not.toBe(key);
    expect(key).not.toContain(SECRET);
    expect(`${GROK_LINK_PATH_PREFIX}${key}`).toMatch(GROK_LINK_MCP_PATH);
  });

  it("reads only 32 base64url bytes as a secret", () => {
    expect(isLinkSecret(SECRET)).toBe(true);
    for (const junk of ["", "short", `${SECRET}A`, `${SECRET.slice(1)}=`, 7, null]) expect(isLinkSecret(junk), String(junk)).toBe(false);
  });

  it("lets a 4 MB export through inside its envelope", () => {
    expect(GROK_LINK_BODY_MAX).toBe(GROK_EXPORT_MAX_CHARS + 64 * 1024);
  });

  it("reads the frames each side sends and refuses anything else", () => {
    expect(toDesktopSchema.parse({ t: "call", id: "c1", message: { jsonrpc: "2.0" } })).toMatchObject({ id: "c1" });
    for (const frame of [{ t: "hello", manifest }, { t: "got", id: "c1" }, { t: "answer", id: "c1", status: 202 }, { t: "answer", id: "c1", status: 200, body: { ok: 1 } }]) {
      expect(fromDesktopSchema.safeParse(frame).success, frame.t).toBe(true);
    }
    for (const junk of [null, {}, { t: "call", id: "c1" }, { t: "got" }, { t: "answer", id: "c1", status: 99 }, { t: "hello", manifest: { ...manifest, offline: "closed" } }, { t: "hello", manifest: { ...manifest, versions: [] } }]) {
      expect(fromDesktopSchema.safeParse(junk).success, JSON.stringify(junk)).toBe(false);
    }
  });
});
