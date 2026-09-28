// The native CUA SDK launches the daemon without CREATE_NO_WINDOW. Derive a
// Windows GUI-subsystem copy for that daemon; keep the upstream CLI unchanged
// for the stdio MCP proxy. No executable section or entry point is modified.
export function createBackgroundExecutable(source) {
  const fail = () => { throw new Error("Unsupported CUA executable: expected a complete x64 PE32+ console image"); };
  if (!Buffer.isBuffer(source) || source.length < 64 || source.toString("ascii", 0, 2) !== "MZ") fail();
  const pe = source.readUInt32LE(60);
  if (pe < 64 || pe + 24 > source.length || source.toString("ascii", pe, pe + 4) !== "PE\0\0") fail();
  const optional = pe + 24;
  const optionalSize = source.readUInt16LE(pe + 20);
  const sectionCount = source.readUInt16LE(pe + 6);
  const sectionTable = optional + optionalSize;
  if (source.readUInt16LE(pe + 4) !== 0x8664 || optionalSize < 152 ||
      sectionTable + sectionCount * 40 > source.length || sectionCount === 0) fail();
  if (source.readUInt16LE(optional) !== 0x20b || source.readUInt16LE(optional + 68) !== 3 ||
      source.readUInt32LE(optional + 108) < 5) fail();

  const certificateEntry = optional + 144;
  const certificateStart = source.readUInt32LE(certificateEntry);
  const certificateSize = source.readUInt32LE(certificateEntry + 4);
  const headersEnd = sectionTable + sectionCount * 40;
  // A modified image must not carry the original publisher's signature. Only
  // remove a trailing certificate table; refuse unfamiliar overlays/layouts.
  if ((certificateStart === 0) !== (certificateSize === 0) ||
      (certificateSize && (certificateStart < headersEnd || certificateStart % 8 !== 0 ||
        certificateStart + certificateSize !== source.length))) fail();
  const imageEnd = certificateSize ? certificateStart : source.length;
  for (let i = 0; i < sectionCount; i++) {
    const section = sectionTable + i * 40;
    const size = source.readUInt32LE(section + 16);
    const start = source.readUInt32LE(section + 20);
    if (size && (start < headersEnd || start + size > imageEnd)) fail();
  }

  const result = Buffer.from(source.subarray(0, imageEnd));
  result.writeUInt16LE(2, optional + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  result.fill(0, certificateEntry, certificateEntry + 8);
  result.writeUInt32LE(0, optional + 64);
  let checksum = 0;
  for (let i = 0; i < result.length; i += 2) {
    checksum += result[i] | ((result[i + 1] ?? 0) << 8);
    checksum = (checksum & 0xffff) + (checksum >>> 16);
  }
  checksum = (checksum & 0xffff) + (checksum >>> 16);
  result.writeUInt32LE(checksum + result.length, optional + 64);
  return result;
}
