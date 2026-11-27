import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.OMB_ATTACHMENTS_MAX_BYTES = String(8 * 1024);
const { ATTACHMENTS_DIR, CLOUD_HOME_ATTACHMENTS_MAX_BYTES, DEFAULT_ATTACHMENTS_MAX_BYTES, attachmentsMaxBytes, saveNamedAttachment } = await import("./attachments.ts");
delete process.env.OMB_ATTACHMENTS_MAX_BYTES;

const partials = () => existsSync(ATTACHMENTS_DIR) ? readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith(".partial")) : [];
async function* chunks(...parts: Buffer[]) { for (const part of parts) yield part; }

describe("the attachment store a move fills", () => {
  it("is larger on a person's own Cloud, unless the server says otherwise", () => {
    expect(attachmentsMaxBytes({})).toBe(DEFAULT_ATTACHMENTS_MAX_BYTES);
    expect(attachmentsMaxBytes({ OMB_CLOUD_ROLE: "home" })).toBe(CLOUD_HOME_ATTACHMENTS_MAX_BYTES);
    expect(CLOUD_HOME_ATTACHMENTS_MAX_BYTES).toBeGreaterThan(DEFAULT_ATTACHMENTS_MAX_BYTES);
    expect(attachmentsMaxBytes({ OMB_CLOUD_ROLE: "home", OMB_ATTACHMENTS_MAX_BYTES: "1000" })).toBe(1000);
  });

  it("keeps an arriving attachment under its own name, once, counted against the store's limit, never leaving a partial file", async () => {
    expect(await saveNamedAttachment("a1.png", chunks(Buffer.alloc(1024, 1)), 1024)).toEqual({ stored: true });
    expect(await saveNamedAttachment("a1.png", chunks(Buffer.alloc(1024, 2)), 1024), "one already here is the same upload").toEqual({ stored: false });
    expect(readFileSync(join(ATTACHMENTS_DIR, "a1.png"))).toEqual(Buffer.alloc(1024, 1));
    await expect(saveNamedAttachment("big.png", chunks(Buffer.alloc(16 * 1024)), 16 * 1024)).rejects.toMatchObject({ status: 507 });
    await expect(saveNamedAttachment("streamed.png", chunks(Buffer.alloc(4 * 1024), Buffer.alloc(6 * 1024)))).rejects.toMatchObject({ status: 507 });
    expect(existsSync(join(ATTACHMENTS_DIR, "big.png")) || existsSync(join(ATTACHMENTS_DIR, "streamed.png"))).toBe(false);
    expect(partials()).toEqual([]);
  });

  it("writes under the partial name the store's cleanup knows, and removes it when the upload breaks", async () => {
    let seen: string[] = [];
    async function* breaking() {
      yield Buffer.alloc(512);
      seen = partials();
      throw new Error("connection reset");
    }
    await expect(saveNamedAttachment("broken.png", breaking())).rejects.toThrow("connection reset");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\.openmaus-upload-[0-9a-f-]+-[0-9a-f-]+\.partial$/iu);
    expect(partials()).toEqual([]);
    expect(existsSync(join(ATTACHMENTS_DIR, "broken.png"))).toBe(false);
  });
});
