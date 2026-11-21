// Reading one site's cookies from another browser's files: Chromium's encrypted SQLite, Firefox's plain SQLite and
// Safari's binarycookies.
//
// Adapted from anomalyco/opencode@5ca87b9 packages/gui-plugins/src/browser/profile/chromium.ts (deriveCbcKey,
// decryptChromium, readChromiumCookies), firefox.ts (readFirefoxCookies, the expiry and SameSite mapping) and safari.ts
// (parseBinaryCookies), MIT License, Copyright (c) 2025 opencode (full text in third_party/opencode/LICENSE). Modified:
// only the chosen site's rows are read at all.
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { inSite, type SourceCookie } from "./policy.ts";
import { readCopy } from "./snapshot.ts";

/**
 * The key a Chromium profile encrypts cookie values with. `gcm`: Windows, AES-256-GCM, unwrapped from `Local State`
 * with DPAPI. `cbc`: macOS and Linux, AES-128-CBC keys derived from the Safe Storage password; `v11` only where a Linux
 * keyring holds one.
 */
export type ChromiumKey =
  | { type: "gcm"; key: Buffer }
  | { type: "cbc"; v10: Buffer; v11: Buffer | null };

export interface SiteRead {
  cookies: SourceCookie[];
  /** Values only the source browser can decrypt (Chrome's app-bound encryption on Windows). */
  protected: number;
  /** Values that would not decrypt or parse. */
  failed: number;
}

/** Chromium's AES-128 key from a Safe Storage password: 1003 PBKDF2 rounds on macOS, 1 on Linux. */
export function deriveCbcKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

/**
 * One `encrypted_value`. Since cookie database version 24 the plain text starts with the SHA-256 of the cookie's host,
 * which is stripped. `v20` is Chrome's app-bound encryption on Windows: only the browser's own elevation service can
 * unwrap it, and it is not attempted.
 */
export function decryptChromium(encrypted: Uint8Array, key: ChromiumKey, host: string): { value: string } | { error: "protected" | "failed" } {
  const buffer = Buffer.from(encrypted);
  const version = buffer.subarray(0, 3).toString("latin1");
  if (version === "v20") return { error: "protected" };
  if ((version !== "v10" && version !== "v11") || (key.type === "gcm" && buffer.length < 3 + 12 + 16)) return { error: "failed" };
  let plain: Buffer;
  try {
    if (key.type === "gcm") {
      const gcm = createDecipheriv("aes-256-gcm", key.key, buffer.subarray(3, 15));
      gcm.setAuthTag(buffer.subarray(-16));
      plain = Buffer.concat([gcm.update(buffer.subarray(15, -16)), gcm.final()]);
    } else {
      const secret = version === "v11" ? key.v11 : key.v10;
      if (!secret) return { error: "failed" };
      const cbc = createDecipheriv("aes-128-cbc", secret, Buffer.alloc(16, 0x20));
      plain = Buffer.concat([cbc.update(buffer.subarray(3)), cbc.final()]);
    }
  } catch {
    return { error: "failed" };
  }
  const digest = createHash("sha256").update(host).digest();
  const text = plain.length >= 32 && plain.subarray(0, 32).equals(digest) ? plain.subarray(32) : plain;
  try {
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(text) };
  } catch {
    return { error: "failed" };
  }
}

/** Seconds between 1601-01-01 (Chromium's epoch) and 1970-01-01. */
const WINDOWS_EPOCH = 11_644_473_600;
const chromiumTime = (value: number | bigint) => (Number(value) ? Number(value) / 1_000_000 - WINDOWS_EPOCH : undefined);
const CHROMIUM_SAME_SITE = ["no_restriction", "lax", "strict"] as const;

/** Rows of `site` and its subdomains, matched in SQL so no other site's value is ever read. */
const SITE_ROWS = (column: string) => `(${column} = ?1 OR ${column} = ?2 OR (length(${column}) > length(?2) AND substr(${column}, -length(?2)) = ?2))`;

interface ChromiumRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: bigint;
  has_expires: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  samesite: bigint;
  top_frame_site_key: string | null;
}

/** A Chromium profile's cookies of one site, decrypted with `key` (asked for only when a row needs it). */
export async function readChromium(database: string, scratch: string, site: string, key: () => Promise<ChromiumKey>): Promise<SiteRead> {
  const rows = await readCopy(database, scratch, (db: DatabaseSync) => {
    const columns = new Set((db.prepare("SELECT name FROM pragma_table_info('cookies')").all() as Array<{ name: string }>).map((row) => row.name));
    const partition = columns.has("top_frame_site_key") ? "top_frame_site_key" : "NULL AS top_frame_site_key";
    const query = db.prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc, has_expires, is_secure, is_httponly, samesite, ${partition} FROM cookies WHERE typeof(host_key) = 'text' AND ${SITE_ROWS("host_key")}`);
    query.setReadBigInts(true);
    return query.all(site, `.${site}`) as unknown as ChromiumRow[];
  });
  const read: SiteRead = { cookies: [], protected: 0, failed: 0 };
  let secret: ChromiumKey | null = null;
  for (const row of rows) {
    if (typeof row.name !== "string" || typeof row.path !== "string" || !inSite(row.host_key, site)) {
      read.failed++;
      continue;
    }
    let value = typeof row.value === "string" ? row.value : "";
    if (!value && row.encrypted_value && row.encrypted_value.length) {
      secret ??= await key();
      const decrypted = decryptChromium(row.encrypted_value, secret, row.host_key);
      if ("error" in decrypted) {
        read[decrypted.error]++;
        continue;
      }
      value = decrypted.value;
    }
    read.cookies.push({
      host: row.host_key,
      name: row.name,
      value,
      path: row.path,
      secure: Boolean(Number(row.is_secure)),
      httpOnly: Boolean(Number(row.is_httponly)),
      expires: Number(row.has_expires) ? chromiumTime(row.expires_utc) : undefined,
      sameSite: CHROMIUM_SAME_SITE[Number(row.samesite)] ?? "unspecified",
      ...(row.top_frame_site_key ? { partitioned: true } : {}),
    });
  }
  return read;
}

interface FirefoxRow {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number | bigint;
  isSecure: number | bigint;
  isHttpOnly: number | bigint;
  sameSite: number | bigint;
}

// Firefox 139 stores the expiry in milliseconds; earlier versions in seconds.
const firefoxExpiry = (value: number | bigint) => {
  const number = Number(value);
  return number > 0 ? (number > 1e11 ? number / 1000 : number) : undefined;
};

/**
 * A Firefox profile's cookies of one site, from `cookies.sqlite`. Values are plain text. Cookies of containers and
 * private windows (any `originAttributes`) stay behind: the default container is the one the person browses in.
 */
export async function readFirefox(profileDir: string, scratch: string, site: string): Promise<SiteRead> {
  const rows = await readCopy(join(profileDir, "cookies.sqlite"), scratch, (db: DatabaseSync) =>
    db.prepare(`SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies WHERE originAttributes = '' AND typeof(host) = 'text' AND ${SITE_ROWS("host")}`)
      .all(site, `.${site}`) as unknown as FirefoxRow[]);
  return {
    cookies: rows.filter((row) => inSite(row.host, site)).map((row) => {
      const secure = Boolean(Number(row.isSecure));
      const sameSite = Number(row.sameSite);
      return {
        host: row.host,
        name: String(row.name),
        value: String(row.value),
        path: String(row.path),
        secure,
        httpOnly: Boolean(Number(row.isHttpOnly)),
        expires: firefoxExpiry(row.expiry),
        // 0 is both an explicit SameSite=None and an unset attribute; only a secure cookie can be sent as None.
        sameSite: sameSite === 1 ? "lax" : sameSite === 2 ? "strict" : secure ? "no_restriction" : "unspecified",
      };
    }),
    protected: 0,
    failed: 0,
  };
}

/** Seconds between 1970-01-01 and 2001-01-01, the epoch of Safari's timestamps. */
const MAC_EPOCH = 978_307_200;

/**
 * Safari's `Cookies.binarycookies`: big-endian page sizes, then pages of little-endian records with null-terminated
 * strings. Every count and offset is checked against the bytes there are, so a damaged file costs no more than its
 * size. Flags: 1 secure, 4 HttpOnly; the file's SameSite bits are not documented, so it stays unspecified.
 */
export function parseBinaryCookies(data: Uint8Array, site: string): SiteRead | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 8 || Buffer.from(data.subarray(0, 4)).toString("latin1") !== "cook") return null;
  const pages = view.getUint32(4);
  if (8 + pages * 4 > data.byteLength) return null;
  const read: SiteRead = { cookies: [], protected: 0, failed: 0 };
  let start = 8 + pages * 4;
  for (let index = 0; index < pages; index++) {
    const size = view.getUint32(8 + index * 4);
    const length = Math.min(size, Math.max(0, data.byteLength - start));
    const page = length >= 8 ? new DataView(data.buffer, data.byteOffset + start, length) : null;
    start += size;
    const records = page ? page.getUint32(4, true) : 0;
    if (!page || 8 + records * 4 > page.byteLength) {
      read.failed++;
      continue;
    }
    for (let item = 0; item < records; item++) {
      const cookie = safariCookie(page, page.getUint32(8 + item * 4, true));
      if (!cookie) read.failed++;
      else if (inSite(cookie.host, site)) read.cookies.push(cookie);
    }
  }
  return read;
}

function safariCookie(page: DataView, offset: number): SourceCookie | null {
  if (offset + 56 > page.byteLength) return null;
  const size = page.getUint32(offset, true);
  if (offset + size > page.byteLength) return null;
  const flags = page.getUint32(offset + 8, true);
  const text = (field: number) => cString(page, offset + page.getUint32(offset + field, true), offset + size);
  const host = text(16);
  const name = text(20);
  const path = text(24);
  const value = text(28);
  if (host === null || name === null || path === null || value === null) return null;
  const expiry = page.getFloat64(offset + 40, true);
  return {
    host,
    name,
    value,
    path,
    secure: (flags & 1) !== 0,
    httpOnly: (flags & 4) !== 0,
    expires: expiry > 0 ? expiry + MAC_EPOCH : undefined,
    sameSite: "unspecified",
  };
}

function cString(page: DataView, start: number, end: number): string | null {
  const bytes = new Uint8Array(page.buffer, page.byteOffset, page.byteLength);
  const stop = bytes.indexOf(0, start);
  if (start >= end || stop < 0 || stop > end) return null;
  return new TextDecoder().decode(bytes.subarray(start, stop));
}

/** Safari's cookie file of one site. Without Full Disk Access macOS answers EPERM: the caller says so. */
export async function readSafari(file: string, site: string): Promise<SiteRead | null> {
  return parseBinaryCookies(await readFile(file), site);
}
