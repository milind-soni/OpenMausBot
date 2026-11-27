// A tiny ZIP writer for tests: local headers, a central directory and its end record, nothing else.
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFixtureMember {
  name: string;
  data?: Buffer | string;
  /** Unix mode bits, file type included (0o100755, 0o120777 for a symlink); omitted means a DOS-style entry. */
  mode?: number;
  method?: 0 | 8;
  /** Overrides the uncompressed size the directory claims. */
  declaredBytes?: number;
}

export function buildZip(members: ZipFixtureMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const data = Buffer.isBuffer(member.data) ? member.data : Buffer.from(member.data ?? "", "utf8");
    const method = member.method ?? 8;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const uncompressed = member.declaredBytes ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(member.mode === undefined ? 20 : 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(member.mode === undefined ? 0 : (member.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
