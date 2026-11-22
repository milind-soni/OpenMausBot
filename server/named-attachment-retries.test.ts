import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";

process.env.OMB_ATTACHMENTS_MAX_BYTES = "1024";
const { ATTACHMENTS_DIR, FILE_MAX_BYTES, __resetAttachmentAccountingForTests, attachmentStorageUsage, saveNamedAttachment } = await import("./attachments.ts");
delete process.env.OMB_ATTACHMENTS_MAX_BYTES;

beforeEach(() => {
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  __resetAttachmentAccountingForTests();
});
async function* chunks(...values: Buffer[]) { for (const value of values) yield value; }

it.each([true, false])("retries an already committed attachment at the quota with a declared length: %s", async (declared) => {
  const bytes = Buffer.alloc(1024, 7);
  expect(await saveNamedAttachment("full.png", chunks(bytes), bytes.length)).toEqual({ stored: true });
  let consumed = false;
  async function* retry() {
    yield bytes.subarray(0, 511);
    yield bytes.subarray(511);
    consumed = true;
  }
  await expect(saveNamedAttachment("full.png", retry(), declared ? bytes.length : undefined)).resolves.toEqual({ stored: false });
  expect(consumed).toBe(true);
  expect(readFileSync(join(ATTACHMENTS_DIR, "full.png"))).toEqual(bytes);
  expect(readdirSync(ATTACHMENTS_DIR)).toEqual(["full.png"]);
  expect(attachmentStorageUsage().usedBytes).toBe(1024);
  await expect(saveNamedAttachment("new.png", chunks(Buffer.from("x")), 1)).rejects.toMatchObject({ status: 507 });
});

it("does not report success when the repeated transfer's body fails", async () => {
  await saveNamedAttachment("landed.png", chunks(Buffer.from("saved")));
  async function* broken() { yield Buffer.from("first"); throw new Error("connection reset"); }
  await expect(saveNamedAttachment("landed.png", broken())).rejects.toThrow("connection reset");
  expect(readFileSync(join(ATTACHMENTS_DIR, "landed.png"), "utf8")).toBe("saved");
  expect(readdirSync(ATTACHMENTS_DIR)).toEqual(["landed.png"]);
  await expect(saveNamedAttachment("landed.png", chunks(), FILE_MAX_BYTES + 1)).rejects.toMatchObject({ status: 413 });
});

it("asks for a retry if an existing attachment disappears while its repeated body drains", async () => {
  await saveNamedAttachment("gone.png", chunks(Buffer.from("saved")));
  async function* removed() { yield Buffer.from("first"); rmSync(join(ATTACHMENTS_DIR, "gone.png")); }
  await expect(saveNamedAttachment("gone.png", removed())).rejects.toMatchObject({ status: 409 });
  expect(existsSync(join(ATTACHMENTS_DIR, "gone.png"))).toBe(false);
});
