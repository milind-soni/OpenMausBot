// Synthetic browser profiles for the cookie import's tests, built in a temporary folder. Nothing here reads, copies or
// looks at a real browser profile or a real key store: `fixtureFiles` throws for any path outside its folder.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BrowserFiles, KeyStore } from "../sources.ts";

/** A BrowserFiles over `home` that refuses every path outside it, Safari's application aside when `safari` says so. */
export function fixtureFiles(home: string, platform: NodeJS.Platform, { safari = false, env = {} }: { safari?: boolean; env?: Record<string, string> } = {}): BrowserFiles {
  // Windows paths over a POSIX fixture folder: the separators turn back into slashes.
  const native = (path: string) => (platform === "win32" ? path.replaceAll("\\", "/") : path);
  const inside = (path: string) => {
    const rel = relative(home, resolve(path));
    if (rel.startsWith("..") || resolve(path) === resolve("/")) throw new Error(`the test touched a path outside its fixture folder: ${path}`);
    return path;
  };
  return {
    platform,
    home,
    env,
    async readText(path) {
      const file = inside(native(path));
      try { return readFileSync(file, "utf8"); } catch { return null; }
    },
    async exists(path) {
      if (path === "/Applications/Safari.app") return safari;
      return existsSync(inside(native(path)));
    },
  };
}

export interface FakeKeys extends KeyStore {
  asked: string[];
}

/** A key store that answers from fixtures, or turns the request down. */
export function fakeKeys({ mac = null, windows = null, linux = null }: { mac?: string | null; windows?: Buffer | null; linux?: string | null }): FakeKeys {
  const asked: string[] = [];
  return {
    asked,
    async macPassword(service, account) {
      asked.push(`mac:${service}:${account}`);
      if (mac === null) throw new Error("User canceled the operation.");
      return `${mac}\n`;
    },
    async windowsUnprotect(blob) {
      asked.push(`windows:${blob.length}`);
      if (windows === null) throw new Error("The data is invalid.");
      return windows;
    },
    async linuxPassword(application) {
      asked.push(`linux:${application}`);
      return linux;
    },
  };
}

export interface ChromiumRowFixture {
  host: string;
  name: string;
  value?: string;
  encrypted?: Buffer;
  path?: string;
  /** Unix seconds; 0 for a session cookie. */
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  /** Chromium's column: -1 unspecified, 0 none, 1 lax, 2 strict. */
  sameSite?: number;
  partition?: string;
}

const WINDOWS_EPOCH = 11_644_473_600;

/** A Chromium `Cookies` database with the columns the importer reads. */
export function chromiumDatabase(file: string, rows: ChromiumRowFixture[], { wal = false }: { wal?: boolean } = {}): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER, source_scheme INTEGER, source_port INTEGER, last_update_utc INTEGER)");
  const insert = db.prepare("INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, last_update_utc) VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 1, ?, 2, 443, 0)");
  for (const row of rows) {
    const expires = row.expires ? BigInt(Math.round((row.expires + WINDOWS_EPOCH) * 1_000_000)) : 0n;
    insert.run(row.host, row.partition ?? "", row.name, row.value ?? "", row.encrypted ?? Buffer.alloc(0), row.path ?? "/", expires, row.secure ? 1 : 0, row.httpOnly ? 1 : 0, row.expires ? 1 : 0, row.sameSite ?? -1);
  }
  return db;
}

/** Chromium's Windows encryption: AES-256-GCM, a 12-byte nonce and a 16-byte tag, the host's digest in front. */
export function gcmValue(key: Buffer, host: string, value: string, digest = true): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plain = Buffer.concat([digest ? createHash("sha256").update(host).digest() : Buffer.alloc(0), Buffer.from(value)]);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]);
}

/** A Chrome `Local State` naming profiles, with a DPAPI-wrapped key for Windows when given. */
export function localState(root: string, profiles: Record<string, string>, wrappedKey?: Buffer): void {
  mkdirSync(root, { recursive: true });
  const info = Object.fromEntries(Object.entries(profiles).map(([id, name]) => [id, { name }]));
  const state = { profile: { info_cache: info }, ...(wrappedKey ? { os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), wrappedKey]).toString("base64") } } : {}) };
  writeFileSync(join(root, "Local State"), JSON.stringify(state));
}

/** A Firefox profile folder with `cookies.sqlite`, listed in `profiles.ini`. */
export function firefoxProfile(root: string, folder: string, name: string, rows: Array<{ host: string; name: string; value: string; path?: string; expiry?: number; secure?: boolean; httpOnly?: boolean; sameSite?: number; originAttributes?: string }>): string {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "profiles.ini"), `[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=${name}\nIsRelative=1\nPath=${folder}\nDefault=1\n`);
  const db = new DatabaseSync(join(root, folder, "cookies.sqlite"));
  db.exec("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0, isPartitionedAttributeSet INTEGER DEFAULT 0)");
  const insert = db.prepare("INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, lastAccessed, creationTime, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)");
  for (const row of rows) insert.run(row.originAttributes ?? "", row.name, row.value, row.host, row.path ?? "/", row.expiry ?? 0, row.secure ? 1 : 0, row.httpOnly ? 1 : 0, row.sameSite ?? 0);
  db.close();
  return join(root, folder);
}

/** Safari's `Cookies.binarycookies`, one page, written as Safari lays it out. */
export function binaryCookies(cookies: Array<{ host: string; name: string; value: string; path?: string; expires?: number; secure?: boolean; httpOnly?: boolean }>): Buffer {
  const MAC_EPOCH = 978_307_200;
  const records = cookies.map((cookie) => {
    const strings = [cookie.host, cookie.name, cookie.path ?? "/", cookie.value].map((text) => Buffer.from(`${text}\0`));
    const header = Buffer.alloc(56);
    let offset = 56;
    const offsets = strings.map((text) => { const at = offset; offset += text.length; return at; });
    header.writeUInt32LE(offset, 0);
    header.writeUInt32LE((cookie.secure ? 1 : 0) | (cookie.httpOnly ? 4 : 0), 8);
    header.writeUInt32LE(offsets[0]!, 16);
    header.writeUInt32LE(offsets[1]!, 20);
    header.writeUInt32LE(offsets[2]!, 24);
    header.writeUInt32LE(offsets[3]!, 28);
    header.writeDoubleLE(cookie.expires ? cookie.expires - MAC_EPOCH : 0, 40);
    return Buffer.concat([header, ...strings]);
  });
  const head = Buffer.alloc(8 + records.length * 4 + 4);
  head.writeUInt32LE(0x100, 0);
  head.writeUInt32LE(records.length, 4);
  let at = head.length;
  records.forEach((record, index) => { head.writeUInt32LE(at, 8 + index * 4); at += record.length; });
  const page = Buffer.concat([head, ...records]);
  const file = Buffer.alloc(8);
  file.write("cook", 0, "latin1");
  file.writeUInt32BE(1, 4);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(page.length, 0);
  return Buffer.concat([file, size, page]);
}
