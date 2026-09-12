import { Inflate, strFromU8, zipSync } from 'fflate';

const MAX_PART_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
interface Part { name: string; method: number; start: number; compressed: number; size: number }

function archiveParts(data: Uint8Array): Part[] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === data.length) { end = offset; break; }
  }
  if (end < 0) {
    if (data[0] === 0x50 && data[1] === 0x4b) throw new Error('invalid ZIP');
    return null; // Legacy XLS and text formats have no ZIP inflation path.
  }
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count > 3000 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== count) throw new Error('archive too large');
  if (offset + view.getUint32(end + 12, true) !== end) throw new Error('invalid ZIP directory');
  const directory = offset;
  const parts: Part[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('invalid ZIP entry');
    const size = view.getUint32(offset + 24, true);
    total += size;
    if (size > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) throw new Error('archive too large');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    if (next > end || (flags & 0x41) || (method !== 0 && method !== 8) || view.getUint16(offset + 34, true) !== 0 || local + 30 > directory) throw new Error('unsupported ZIP entry');
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method || view.getUint16(local + 26, true) !== nameLength) throw new Error('invalid ZIP header');
    const start = local + 30 + nameLength + view.getUint16(local + 28, true);
    if (start + compressed > directory) throw new Error('invalid ZIP range');
    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength);
    if (!nameBytes.every((byte, index) => byte === data[local + 30 + index])) throw new Error('invalid ZIP filename');
    const name = strFromU8(nameBytes, !(flags & 0x800));
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) throw new Error('invalid ZIP filename');
    names.add(name);
    parts.push({ name, method, start, compressed, size });
    offset = next;
  }
  if (offset !== end) throw new Error('invalid ZIP directory');
  return parts;
}

/** Cheap directory validation; actual output must also be bounded by prepareOfficeArchive. */
export function checkOfficeArchive(data: Uint8Array): void { archiveParts(data); }

/** Never hand the original compressed archive to an unbounded Office decoder.
 * Inflate in small input slices, reject excess output immediately, then rebuild
 * a stored-only ZIP containing exactly the validated parts. Both Office readers
 * therefore receive no attacker-controlled DEFLATE stream or alternate headers. */
export function prepareOfficeArchive(data: Uint8Array): Uint8Array {
  const parts = archiveParts(data);
  if (!parts) return data;
  const files: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const part of parts) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const accept = (chunk: Uint8Array) => {
      size += chunk.length;
      total += chunk.length;
      if (size > part.size || size > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) throw new Error('archive inflated output exceeds limit');
      chunks.push(chunk);
    };
    const payload = data.subarray(part.start, part.start + part.compressed);
    if (part.method === 0) accept(payload);
    else {
      const inflater = new Inflate(accept);
      // Small DEFLATE input slices bound transient output before each callback.
      for (let offset = 0; offset < payload.length; offset += 1024) {
        inflater.push(payload.subarray(offset, offset + 1024), offset + 1024 >= payload.length);
      }
      if (!payload.length) throw new Error('invalid DEFLATE stream');
    }
    if (size !== part.size) throw new Error('invalid ZIP inflated size');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    files[part.name] = bytes;
  }
  return zipSync(files, { level: 0 });
}
