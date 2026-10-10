import { describe, expect, it } from "vitest";
import { createBackgroundExecutable } from "./cua-windows-background.mjs";

const pe = 128, optional = pe + 24, section = optional + 240;
function image(signed = true) {
  const bytes = Buffer.alloc(signed ? 1040 : 1025);
  bytes.write("MZ");
  bytes.writeUInt32LE(pe, 60);
  bytes.write("PE\0\0", pe);
  bytes.writeUInt16LE(0x8664, pe + 4);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(240, pe + 20);
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(4096, optional + 16); // entry point
  bytes.writeUInt16LE(3, optional + 68);
  bytes.writeUInt32LE(16, optional + 108);
  if (signed) {
    bytes.writeUInt32LE(1032, optional + 144);
    bytes.writeUInt32LE(8, optional + 148);
  }
  bytes.write(".text", section);
  bytes.writeUInt32LE(512, section + 16);
  bytes.writeUInt32LE(512, section + 20);
  bytes.fill(0x79, 512, 1025);
  return bytes;
}

describe("background CUA executable", () => {
  it.each([true, false])("preserves executable bytes, entry point and original (signed=%s)", signed => {
    const source = image(signed), original = Buffer.from(source);
    const result = createBackgroundExecutable(source);
    expect(source).toEqual(original);
    expect(result.length).toBe(signed ? 1032 : 1025);
    expect(result.readUInt16LE(optional + 68)).toBe(2);
    expect(result.subarray(optional + 144, optional + 152)).toEqual(Buffer.alloc(8));
    const normalized = Buffer.from(result);
    for (const [start, length] of [[optional + 64, 4], [optional + 68, 2], [optional + 144, 8]]) {
      source.copy(normalized, start, start, start + length);
    }
    expect(normalized).toEqual(source.subarray(0, result.length));
    // Independent 16-bit complement checksum, including an odd final byte.
    const words = Array.from({ length: Math.ceil(result.length / 2) }, (_, i) =>
      i * 2 >= optional + 64 && i * 2 < optional + 68 ? 0 :
        (result[i * 2] + (result[i * 2 + 1] ?? 0) * 256));
    let sum = words.reduce((a, b) => a + b, 0);
    while (sum > 65535) sum = (sum % 65536) + Math.floor(sum / 65536);
    expect(result.readUInt32LE(optional + 64)).toBe(sum + result.length);
  });

  it.each([
    ["missing DOS header", b => b.fill(0, 0, 2)],
    ["bad PE offset", b => b.writeUInt32LE(0xffffffff, 60)],
    ["missing PE signature", b => b.fill(0, pe, pe + 4)],
    ["wrong architecture", b => b.writeUInt16LE(0xaa64, pe + 4)],
    ["PE32 image", b => b.writeUInt16LE(0x10b, optional)],
    ["short optional header", b => b.writeUInt16LE(100, pe + 20)],
    ["truncated section table", b => b.writeUInt16LE(90, pe + 6)],
    ["missing sections", b => b.writeUInt16LE(0, pe + 6)],
    ["already modified subsystem", b => b.writeUInt16LE(2, optional + 68)],
    ["missing certificate directory", b => b.writeUInt32LE(4, optional + 108)],
    ["certificate overlaps headers", b => b.writeUInt32LE(16, optional + 144)],
    ["certificate is not last", b => b.writeUInt32LE(16, optional + 148)],
    ["certificate unaligned", b => { b.writeUInt32LE(1031, optional + 144); b.writeUInt32LE(9, optional + 148); }],
    ["certificate has no offset", b => b.writeUInt32LE(0, optional + 144)],
    ["section overlaps headers", b => b.writeUInt32LE(4, section + 20)],
    ["section includes certificate", b => b.writeUInt32LE(528, section + 16)],
  ])("rejects %s", (_name, mutate) => {
    const bytes = image();
    mutate(bytes);
    expect(() => createBackgroundExecutable(bytes)).toThrow("Unsupported CUA executable");
  });

  it("rejects short or non-buffer input", () => {
    for (const value of [null, "MZ", Buffer.alloc(0), Buffer.alloc(63)]) {
      expect(() => createBackgroundExecutable(value)).toThrow("Unsupported CUA executable");
    }
  });
});
