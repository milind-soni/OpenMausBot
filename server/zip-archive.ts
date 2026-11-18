// Reads a ZIP that was already checked against a pinned SHA-256, without loading it into memory: the central directory
// is parsed from the end of the file, and each member is inflated straight to disk, never past the size it declares.
// No ZIP64, no encryption, no links: a pinned vendor archive needs none of them. listZipSync and readZipMemberSync
// read archives nobody vouched for, in slices the caller bounds.
import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readSync } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";

export interface ZipMember {
  name: string;
  compression: 0 | 8;
  compressedBytes: number;
  uncompressedBytes: number;
  localHeaderOffset: number;
  externalAttributes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_BYTES = 22 + 0xffff;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;

/** A central-directory record; `member` is null for one that cannot be read plainly (encrypted, ZIP64, on another
 * disk, or compressed some other way). */
export interface ZipRecord {
  name: string;
  uncompressedBytes: number;
  member: ZipMember | null;
}

function endOfDirectory(tail: Buffer, tailOffset: number): { entryCount: number; directoryBytes: number; directoryOffset: number } {
  let eocd = -1;
  for (let cursor = tail.length - 22; cursor >= 0; cursor -= 1) {
    if (
      tail.readUInt32LE(cursor) === EOCD_SIGNATURE
      && cursor + 22 + tail.readUInt16LE(cursor + 20) === tail.length
    ) {
      eocd = cursor;
      break;
    }
  }
  if (eocd < 0) throw new Error("The verified archive has no valid ZIP directory.");
  const disk = tail.readUInt16LE(eocd + 4);
  const directoryDisk = tail.readUInt16LE(eocd + 6);
  const diskEntries = tail.readUInt16LE(eocd + 8);
  const entryCount = tail.readUInt16LE(eocd + 10);
  const directoryBytes = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (
    disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount
    || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff
    || directoryOffset + directoryBytes > tailOffset + eocd
  ) throw new Error("The verified archive uses an unsupported ZIP layout.");
  return { entryCount, directoryBytes, directoryOffset };
}

/** At most `limit` records from the start of a central directory. */
function directoryRecords(directory: Buffer, limit: number): ZipRecord[] {
  const records: ZipRecord[] = [];
  let cursor = 0;
  while (cursor < directory.length && records.length < limit) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("The verified archive directory is invalid.");
    }
    const flags = directory.readUInt16LE(cursor + 8);
    const compression = directory.readUInt16LE(cursor + 10);
    const compressedBytes = directory.readUInt32LE(cursor + 20);
    const uncompressedBytes = directory.readUInt32LE(cursor + 24);
    const nameBytes = directory.readUInt16LE(cursor + 28);
    const extraBytes = directory.readUInt16LE(cursor + 30);
    const commentBytes = directory.readUInt16LE(cursor + 32);
    const startDisk = directory.readUInt16LE(cursor + 34);
    const externalAttributes = directory.readUInt32LE(cursor + 38);
    const localHeaderOffset = directory.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (next > directory.length) throw new Error("The verified archive directory is invalid.");
    const name = directory.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8");
    const plain = startDisk === 0 && (flags & 1) === 0
      && compressedBytes !== 0xffffffff && uncompressedBytes !== 0xffffffff
      && localHeaderOffset !== 0xffffffff;
    records.push({
      name,
      uncompressedBytes,
      member: plain && (compression === 0 || compression === 8)
        ? { name, compression, compressedBytes, uncompressedBytes, localHeaderOffset, externalAttributes }
        : null,
    });
    cursor = next;
  }
  return records;
}

/** The members a ZIP's central directory lists; more than `maxEntries` is refused. */
export async function readZipDirectory(path: string, maxEntries: number): Promise<ZipMember[]> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const tailBytes = Math.min(info.size, MAX_EOCD_BYTES);
    const tail = Buffer.alloc(tailBytes);
    const tailOffset = info.size - tailBytes;
    if ((await handle.read(tail, 0, tailBytes, tailOffset)).bytesRead !== tailBytes) {
      throw new Error("The verified archive was truncated.");
    }
    const { entryCount, directoryBytes, directoryOffset } = endOfDirectory(tail, tailOffset);
    if (entryCount > maxEntries) throw new Error("The verified archive uses an unsupported ZIP layout.");

    const directory = Buffer.alloc(directoryBytes);
    if ((await handle.read(directory, 0, directoryBytes, directoryOffset)).bytesRead !== directoryBytes) {
      throw new Error("The verified archive directory was truncated.");
    }
    const records = directoryRecords(directory, Infinity);
    if (records.length !== entryCount) throw new Error("The verified archive member count is invalid.");
    return records.map(({ member }) => {
      if (!member) throw new Error("The verified archive contains an unsupported ZIP member.");
      return member;
    });
  } finally {
    await handle.close();
  }
}

/** The first `maxEntries` records of a ZIP, reading at most `maxDirectoryBytes` of its directory, and how many it holds. */
export function listZipSync(path: string, limits: { maxEntries: number; maxDirectoryBytes: number }): { total: number; records: ZipRecord[] } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, MAX_EOCD_BYTES));
    if (readSync(fd, tail, 0, tail.length, size - tail.length) !== tail.length) throw new Error("The archive was truncated.");
    const { entryCount, directoryBytes, directoryOffset } = endOfDirectory(tail, size - tail.length);
    const directory = Buffer.alloc(Math.min(directoryBytes, limits.maxDirectoryBytes));
    if (readSync(fd, directory, 0, directory.length, directoryOffset) !== directory.length) throw new Error("The archive directory was truncated.");
    const wanted = Math.min(entryCount, limits.maxEntries);
    const records = directoryRecords(directory, wanted);
    if (records.length !== wanted) throw new Error("The archive directory is invalid.");
    return { total: entryCount, records };
  } finally {
    closeSync(fd);
  }
}

function localHeaderLengths(header: Buffer, entry: ZipMember): { nameBytes: number; extraBytes: number } {
  if (
    header.readUInt32LE(0) !== LOCAL_SIGNATURE
    || header.readUInt16LE(8) !== entry.compression
    || (header.readUInt16LE(6) & 1) !== 0
  ) throw new Error("A verified archive member header is invalid.");
  return { nameBytes: header.readUInt16LE(26), extraBytes: header.readUInt16LE(28) };
}

/** One member's bytes, read synchronously; the caller bounds its declared sizes, and inflating past them is refused. */
export function readZipMemberSync(archivePath: string, entry: ZipMember): Buffer {
  const fd = openSync(archivePath, "r");
  try {
    const header = Buffer.alloc(30);
    if (readSync(fd, header, 0, header.length, entry.localHeaderOffset) !== header.length) throw new Error("An archive member header was truncated.");
    const { nameBytes, extraBytes } = localHeaderLengths(header, entry);
    const name = Buffer.alloc(nameBytes);
    if (readSync(fd, name, 0, nameBytes, entry.localHeaderOffset + 30) !== nameBytes || name.toString("utf8") !== entry.name) {
      throw new Error("An archive member name did not match its directory.");
    }
    const data = Buffer.alloc(entry.compressedBytes);
    if (readSync(fd, data, 0, data.length, entry.localHeaderOffset + 30 + nameBytes + extraBytes) !== data.length) {
      throw new Error("An archive member was truncated.");
    }
    // zlib refuses a maxOutputLength of 0.
    const bytes = entry.compression === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(entry.uncompressedBytes, 1) }) : data;
    if (bytes.length !== entry.uncompressedBytes) throw new Error("An archive member did not match its declared size.");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

async function memberDataOffset(path: string, entry: ZipMember): Promise<number> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(30);
    if ((await handle.read(header, 0, header.length, entry.localHeaderOffset)).bytesRead !== header.length) {
      throw new Error("A verified archive member header was truncated.");
    }
    const { nameBytes, extraBytes } = localHeaderLengths(header, entry);
    const name = Buffer.alloc(nameBytes);
    if ((await handle.read(name, 0, nameBytes, entry.localHeaderOffset + 30)).bytesRead !== nameBytes) {
      throw new Error("A verified archive member name was truncated.");
    }
    if (name.toString("utf8") !== entry.name) throw new Error("A verified archive member name did not match its directory.");
    return entry.localHeaderOffset + 30 + nameBytes + extraBytes;
  } finally {
    await handle.close();
  }
}

/** Inflates one member to `destination` (which must not exist), refusing a byte past its declared size. */
export async function extractZipMember(archivePath: string, entry: ZipMember, destination: string, mode = 0o700): Promise<void> {
  const dataOffset = await memberDataOffset(archivePath, entry);
  const expectedBytes = entry.uncompressedBytes;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes <= expectedBytes ? null : new Error("An extracted file exceeded its declared size."), chunk);
    },
  });
  if (entry.compressedBytes === 0) {
    // A stored empty file has no data to read; createReadStream cannot express an empty range.
    await writeFile(destination, "", { flag: "wx", mode });
  } else {
    const source = createReadStream(archivePath, {
      start: dataOffset,
      end: dataOffset + entry.compressedBytes - 1,
    });
    const writer = createWriteStream(destination, { flags: "wx", mode });
    if (entry.compression === 8) await pipeline(source, createInflateRaw(), counter, writer);
    else await pipeline(source, counter, writer);
  }
  if (bytes !== expectedBytes) throw new Error("An extracted file was truncated.");
}

// Windows opens these as devices whatever the extension or folder, and ignores spaces before the extension: `NUL.txt`,
// `CON .txt` and `con/x` are not files. COM and LPT take 0-9 and the superscripts ¹²³.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/iu;
// A backslash, `:` (a drive or an NTFS stream) and the other characters Windows refuses in a name.
const UNSAFE_CHARACTER = /[\\:<>"|?*]/u;

/** A relative, `/`-separated path every platform can hold as plain files: no empty, `.` or `..` segment, no drive,
 * stream, device name or Windows-forbidden character, and no segment ending in a dot or a space. */
export function safeArchivePath(name: string): boolean {
  if (!name || name.startsWith("/") || UNSAFE_CHARACTER.test(name)) return false;
  if ([...name].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."
    && !segment.endsWith(".") && !segment.endsWith(" ") && !WINDOWS_DEVICE.test(segment));
}

/** Every member of a verified ZIP into `outputDirectory`: plain files and folders only, each under the folder. */
export async function extractZip(archivePath: string, outputDirectory: string, options: { maxEntries: number }): Promise<void> {
  const entries = await readZipDirectory(archivePath, options.maxEntries);
  const seen = new Set<string>();
  for (const entry of entries) {
    const directory = entry.name.endsWith("/");
    const name = directory ? entry.name.slice(0, -1) : entry.name;
    const unixType = (entry.externalAttributes >>> 16) & UNIX_TYPE_MASK;
    const key = name.toLowerCase();
    if (
      !safeArchivePath(name) || seen.has(key)
      || (unixType !== 0 && unixType !== (directory ? UNIX_DIRECTORY : UNIX_FILE))
      || (directory && entry.uncompressedBytes !== 0)
    ) throw new Error("The archive contains an unexpected or unsafe file.");
    seen.add(key);
  }
  for (const entry of entries) {
    const directory = entry.name.endsWith("/");
    const name = directory ? entry.name.slice(0, -1) : entry.name;
    const target = join(outputDirectory, ...name.split("/"));
    if (directory) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    const parts = name.split("/");
    if (parts.length > 1) await mkdir(join(outputDirectory, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
    const executable = ((entry.externalAttributes >>> 16) & 0o111) !== 0;
    await extractZipMember(archivePath, entry, target, executable ? 0o755 : 0o644);
  }
}
