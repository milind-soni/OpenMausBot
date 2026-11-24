import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../../atomic.ts";
import { browserEngineEncryptionKey } from "../../browser-engine.ts";
import type { CdpBrowser } from "../cdp/browser.ts";
import type { SourceCookie, WritableCookie } from "../cookies/policy.ts";
import { cdpSink } from "../cookies/sinks.ts";
import { profileDir } from "./profile.ts";

const JAR_FILE = "omb-cookies.enc";
const CDP_TIMEOUT_MS = 2_000;

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
  partitionKey?: unknown;
  partitionKeyOpaque?: boolean;
}

interface EncryptedJar {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

function jarKey(dataDir: string): Buffer {
  return Buffer.from(browserEngineEncryptionKey(dataDir), "hex");
}

function jarPath(dataDir: string, profileKey: string): string {
  return join(profileDir(dataDir, profileKey), JAR_FILE);
}

function cookieIdentity(cookie: Pick<StoredCookie, "name" | "domain" | "path">): string {
  return `${cookie.name}\0${cookie.domain}\0${cookie.path || "/"}`;
}

function isPartitionedCookie(cookie: Pick<StoredCookie, "partitionKey" | "partitionKeyOpaque">): boolean {
  return cookie.partitionKey != null || cookie.partitionKeyOpaque !== undefined;
}

function isLivePersistableCookie(cookie: StoredCookie, nowSec: number): boolean {
  if (!cookie.name || !cookie.domain || isPartitionedCookie(cookie)) return false;
  if (cookie.session !== true && typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires <= nowSec) {
    return false;
  }
  return true;
}

function normalizeSameSite(value: string | undefined, secure: boolean): SourceCookie["sameSite"] {
  if (value === "Strict") return "strict";
  if (value === "Lax") return "lax";
  if (value === "None" && secure) return "no_restriction";
  return "unspecified";
}

function toWritableCookie(cookie: StoredCookie): WritableCookie {
  const secure = cookie.secure === true;
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  const path = cookie.path && cookie.path.startsWith("/") ? cookie.path : "/";
  const persistent = cookie.session !== true && typeof cookie.expires === "number" && cookie.expires > 0;
  return {
    url: `${secure ? "https" : "http"}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
    path,
    secure,
    httpOnly: cookie.httpOnly === true,
    sameSite: normalizeSameSite(cookie.sameSite, secure),
    ...(persistent ? { expirationDate: cookie.expires } : {}),
  };
}

function readJar(dataDir: string, profileKey: string): StoredCookie[] {
  const file = jarPath(dataDir, profileKey);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EncryptedJar>;
    if (parsed.v !== 1 || typeof parsed.iv !== "string" || typeof parsed.tag !== "string" || typeof parsed.data !== "string") {
      return [];
    }
    const decipher = createDecipheriv("aes-256-gcm", jarKey(dataDir), Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const cookies = JSON.parse(plaintext);
    return Array.isArray(cookies) ? (cookies as StoredCookie[]) : [];
  } catch {
    return [];
  }
}

function writeJar(dataDir: string, profileKey: string, cookies: StoredCookie[]): void {
  const file = jarPath(dataDir, profileKey);
  if (cookies.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", jarKey(dataDir), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(cookies), "utf8"), cipher.final()]);
  const payload: EncryptedJar = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(payload), { mode: 0o600 });
}

/** Captures current Chrome cookies (including session cookies) into an encrypted per-profile jar on disk. */
export async function snapshotCookies(
  browser: CdpBrowser,
  dataDir: string,
  profileKey: string,
  nowSec = Math.floor(Date.now() / 1000),
  shouldWrite: () => boolean = () => true,
): Promise<number> {
  const response = await browser.connection.root.send<{ cookies?: StoredCookie[] }>("Storage.getCookies", {}, { timeoutMs: CDP_TIMEOUT_MS });
  const deduped = new Map<string, StoredCookie>();
  for (const cookie of response.cookies ?? []) {
    if (!isLivePersistableCookie(cookie, nowSec)) continue;
    deduped.set(cookieIdentity(cookie), cookie);
  }
  const kept = [...deduped.values()];
  if (!shouldWrite()) return 0;
  writeJar(dataDir, profileKey, kept);
  return kept.length;
}

/** Restores any missing cookies from the encrypted jar back into Chrome without clobbering newer live cookies. */
export async function remountCookies(
  browser: CdpBrowser,
  dataDir: string,
  profileKey: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<number> {
  const stored = readJar(dataDir, profileKey).filter((cookie) => isLivePersistableCookie(cookie, nowSec));
  if (stored.length === 0) return 0;
  const live = await browser.connection.root.send<{ cookies?: StoredCookie[] }>("Storage.getCookies", {}, { timeoutMs: CDP_TIMEOUT_MS });
  const present = new Set((live.cookies ?? []).filter((cookie) => !isPartitionedCookie(cookie)).map(cookieIdentity));
  const missing = stored.filter((cookie) => !present.has(cookieIdentity(cookie)));
  if (missing.length === 0) return 0;
  const result = await cdpSink((method, params) => browser.connection.root.send(method, params, { timeoutMs: CDP_TIMEOUT_MS })).write(
    missing.map(toWritableCookie),
  );
  return result.written;
}
