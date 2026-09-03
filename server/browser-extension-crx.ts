// Pure pipeline for reading a Chrome extension off disk: walk the tree,
// parse and judge its manifest, hash the bytes. No state, no I/O beyond
// reading the directory it is handed, so every rule here is unit-testable
// without a browser or a session.
//
// House style: server/skill-fetch.ts is the sibling — a pure fetch/parse
// module that server/skills.ts drives. Same split here, for the same reason:
// the policy that decides what a person is allowed to install must be
// readable on its own, without the file-writing around it.
//
// Two ideas carry most of the weight:
//
//   Refuse vs. warn. We refuse only what fights the built-in browser's
//   security model — APIs that could detach our CDP session, reach native
//   binaries, or write to the user's disk. We warn about everything that
//   merely will not work, because Electron implements a subset of the
//   Chrome extension APIs. Refusing "will not work" would block extensions
//   whose main feature is a content script and whose broken half is
//   incidental; pretending it works would be worse than either.
//
//   The tree hash. What a person reviews and what the browser later loads
//   must be the same bytes. Every file's path and contents fold into one
//   sha256, recomputed before enablement (server) and again before
//   loadExtension (Electron, across the process boundary).
import { createHash, createVerify } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { unzipSync } from "fflate";

/** Bounds against a pathological archive, sized against real extensions
 * rather than round numbers: Bitwarden unpacks to about 79MB, and
 * Wappalyzer ships roughly 13,000 fingerprint icons, so earlier limits of
 * 100MB and 5,000 entries refused both.
 *
 * IMPORTANT: electron/browser-extensions.cjs walks the same trees to
 * recompute the hash and MUST use identical values. A tighter cap there is
 * the dangerous direction — the server installs a large extension happily
 * and that side then refuses to hash it, which reads as a failed integrity
 * check and silently never loads it. A test asserts the two stay equal. */
export const UNPACKED_MAX_BYTES = 256 * 1024 * 1024;
/** The largest .crx we will pull down. Sized against real extensions rather
 * than a round number: Bitwarden is about 22MB and Wappalyzer about 33MB, so
 * a 30MB cap refused a legitimate extension. The whole archive is buffered
 * in memory before it is verified, which is what keeps this bounded at all. */
export const CRX_MAX_BYTES = 64 * 1024 * 1024;
export const CRX_DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_ENTRIES = 20_000;
export const MANIFEST_MAX_BYTES = 256 * 1024;
/** Manifests carry long permission lists; keep the record bounded anyway. */
const MAX_PERMISSIONS = 64;
const MAX_PERMISSION_CHARS = 64;
/** Entries the walk never reads or hashes. `.git`, `.DS_Store` and
 * `node_modules` are noise Chrome ignores too. `_metadata` is different and
 * matters: it is Chrome's reserved directory for the Web Store's content
 * verification data, and Chromium DELETES it from an unpacked extension the
 * first time it loads one. A hash that included it passed at install and at
 * enable, then failed forever after the first load, reading as "changed
 * after review". Mirrored in electron/browser-extensions.cjs, whose walk
 * must match this one exactly. */
const SKIPPED_ENTRIES = new Set([".git", ".DS_Store", "node_modules", "_metadata"]);

/** One file of an unpacked extension, path relative to the tree root and
 * always posix-separated so the hash is identical on every platform. */
export interface ExtensionFile {
  path: string;
  bytes: Buffer;
}

export interface ExtensionManifestFacts {
  name: string;
  version: string;
  manifestVersion: 2 | 3;
  permissions: string[];
  hostPermissions: string[];
  hasContentScripts: boolean;
  hasBackground: boolean;
  /** Declares a toolbar button, which the built-in browser cannot show. */
  hasAction: boolean;
  warnings: string[];
}

/** APIs that fight the built-in browser's security model. A person cannot
 * review their way past these, because the risk is not "does it work" but
 * "what does it reach". `debugger` is the interesting one: in Electron 43
 * `chrome.debugger` is simply undefined, so the permission is inert today —
 * it is refused as a standing policy against a future Electron that
 * implements it, where an extension could detach our own CDP session.
 *
 * Kept as tuples so the review dialog can say *why*, not just *no*. */
const REFUSED_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ["nativeMessaging", "can talk to native programs outside the browser"],
  ["debugger", "would fight the debugger connection the bot drives the page with"],
  ["proxy", "can reroute every request the browser makes"],
  ["management", "can disable or remove other extensions"],
  ["downloads", "the built-in browser refuses downloads"],
  ["downloads.open", "the built-in browser refuses downloads"],
  ["tabCapture", "can record the page the bot is working in"],
  ["desktopCapture", "can record the screen"],
];

/** APIs the built-in browser does not implement, or implements in a way that
 * changes what the extension can do. Each one is a sentence the review
 * dialog shows verbatim, so a person can decide with the real tradeoff in
 * front of them. */
const WARNED_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ["declarativeNetRequest", "network filtering does not run in the built-in browser, so content blocking will not work"],
  ["declarativeNetRequestWithHostAccess", "network filtering does not run in the built-in browser, so content blocking will not work"],
  ["webRequestBlocking", "OpenMausBot's own network policy takes precedence, so this extension cannot block or rewrite requests"],
  ["webRequest", "OpenMausBot's own network policy takes precedence, so this extension cannot intercept requests"],
  ["sidePanel", "the built-in browser has no side panel"],
  ["identity", "the built-in browser cannot complete this extension's sign-in flow"],
  ["cookies", "the built-in browser does not expose the cookies API"],
  ["notifications", "the built-in browser does not show extension notifications"],
  ["contextMenus", "the built-in browser has no extension context menus"],
  ["alarms", "the built-in browser does not run extension alarms"],
  ["idle", "the built-in browser does not report idle state"],
  ["offscreen", "the built-in browser does not support offscreen documents"],
  ["privacy", "the built-in browser does not expose the privacy API"],
  ["clipboardRead", "reads the clipboard on pages the bot opens"],
  ["history", "reads browsing history"],
  ["unlimitedStorage", "stores unlimited data in this browser profile"],
];

/** A host pattern this broad means the extension runs everywhere the bot
 * goes — the single most important thing for a person to see. */
const ALL_HOSTS = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/;

export interface ManifestRefusal {
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > MAX_PERMISSION_CHARS) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= MAX_PERMISSIONS) break;
  }
  return out;
}

/** `__MSG_extName__` resolved from the extension's own `_locales`. Chrome
 * does this at load time; we do it so the review dialog and the settings
 * list show a real name instead of a placeholder. Best effort: an
 * unresolvable placeholder falls back to the raw string. */
function resolveMessage(raw: string, files: Map<string, Buffer>, defaultLocale: string): string {
  const match = /^__MSG_([A-Za-z0-9_@]+)__$/.exec(raw.trim());
  if (!match) return raw;
  const key = match[1]!;
  const candidates = [defaultLocale, "en", "en_US"].filter(Boolean);
  for (const locale of candidates) {
    const bytes = files.get(`_locales/${locale}/messages.json`);
    if (!bytes) continue;
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isRecord(parsed)) continue;
      // Chrome's message keys are case-insensitive.
      for (const [name, entry] of Object.entries(parsed)) {
        if (name.toLowerCase() !== key.toLowerCase()) continue;
        if (isRecord(entry) && typeof entry.message === "string" && entry.message.trim()) {
          return entry.message.trim();
        }
      }
    } catch {
      // A malformed locale file is not a reason to refuse the extension.
    }
  }
  return raw;
}

/**
 * Read the manifest and decide what this extension is and whether it may be
 * installed at all. Returns facts plus warnings for the review dialog, or a
 * single refusal reason.
 */
export function parseExtensionManifest(files: ExtensionFile[]): ExtensionManifestFacts | ManifestRefusal {
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  const raw = byPath.get("manifest.json");
  if (!raw) return { error: "that folder has no manifest.json at its top level" };
  if (raw.byteLength > MANIFEST_MAX_BYTES) return { error: "manifest.json is too large to be a real extension manifest" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { error: "manifest.json is not valid JSON" };
  }
  if (!isRecord(parsed)) return { error: "manifest.json must be a JSON object" };

  const manifestVersion = parsed.manifest_version;
  if (manifestVersion !== 2 && manifestVersion !== 3) {
    return { error: "only Manifest V2 and V3 extensions can be installed" };
  }

  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!/^\d+(\.\d+){0,3}$/.test(version)) {
    return { error: "manifest.json needs a version like 1.2.3" };
  }

  const defaultLocale = typeof parsed.default_locale === "string" ? parsed.default_locale : "en";
  const rawName = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!rawName) return { error: "manifest.json needs a name" };
  const name = resolveMessage(rawName, byPath, defaultLocale).slice(0, 120);

  const permissions = stringList(parsed.permissions);
  const optional = stringList(parsed.optional_permissions);
  const hostPermissions = stringList(parsed.host_permissions);

  // MV2 kept host patterns in `permissions`; split them out so both
  // manifest versions present the same two lists to the reviewer.
  const declaredHosts = [...hostPermissions];
  const declaredApis: string[] = [];
  for (const entry of permissions) {
    if (entry.includes("://") || entry === "<all_urls>") {
      if (!declaredHosts.includes(entry)) declaredHosts.push(entry);
    } else {
      declaredApis.push(entry);
    }
  }

  // Required or merely optional makes no difference: an extension that can
  // request a permission at runtime can reach it at runtime.
  const asksFor = (permission: string): boolean => declaredApis.includes(permission) || optional.includes(permission);

  for (const [permission, why] of REFUSED_PERMISSIONS) {
    if (asksFor(permission)) {
      return { error: `this extension asks for "${permission}", which OpenMausBot does not allow: it ${why}` };
    }
  }

  const contentScripts = Array.isArray(parsed.content_scripts) ? parsed.content_scripts : [];
  for (const script of contentScripts) {
    if (!isRecord(script)) continue;
    for (const pattern of stringList(script.matches)) {
      if (!declaredHosts.includes(pattern)) declaredHosts.push(pattern);
    }
  }

  const background = isRecord(parsed.background) ? parsed.background : null;
  // MV3 calls it `action`; MV2 called it `browser_action`.
  const action = [parsed.action, parsed.browser_action].find(isRecord) ?? null;

  const warnings: string[] = [];
  for (const [permission, why] of WARNED_PERMISSIONS) {
    if (asksFor(permission)) warnings.push(`Asks for "${permission}": ${why}.`);
  }
  if (declaredHosts.some((pattern) => ALL_HOSTS.test(pattern))) {
    warnings.push("Runs on every page any bot opens, in every browser profile.");
  }
  if (manifestVersion === 2) {
    warnings.push("Built on Manifest V2, which Chrome has retired. It may stop working.");
  }
  if (background && typeof background.service_worker === "string") {
    warnings.push(
      "Has a background service worker. It runs, but storage change events do not reach it, so parts of the extension may behave oddly.",
    );
  }
  if (action && typeof action.default_popup === "string") {
    warnings.push("Has a toolbar popup, which the built-in browser cannot show yet. Features behind that button will be unreachable.");
  }
  if (isRecord(parsed.side_panel) || isRecord(parsed.sidebar_action)) {
    warnings.push("Has a side panel, which the built-in browser cannot show.");
  }
  if (isRecord(parsed.commands)) {
    warnings.push("Declares keyboard shortcuts, which the built-in browser does not register.");
  }
  if (!contentScripts.length && !background) {
    warnings.push("Has neither content scripts nor a background script, so it may do nothing in the built-in browser.");
  }

  return {
    name,
    version,
    manifestVersion,
    permissions: declaredApis.slice(0, MAX_PERMISSIONS),
    hostPermissions: declaredHosts.slice(0, MAX_PERMISSIONS),
    hasContentScripts: contentScripts.length > 0,
    hasBackground: Boolean(background),
    hasAction: Boolean(action),
    warnings,
  };
}

export interface WalkRefusal {
  error: string;
}

/**
 * Read an unpacked extension directory into memory.
 *
 * Symlinks are never followed and never copied — a link is how a reviewed
 * tree smuggles in bytes nobody looked at, and how a copy escapes the folder
 * the person chose. Anything that is not a regular file or a directory is
 * skipped, and the caps keep a hostile or mistaken folder from exhausting
 * memory before we can refuse it.
 */
export function readUnpackedExtension(root: string): ExtensionFile[] | WalkRefusal {
  const files: ExtensionFile[] = [];
  let total = 0;

  const walk = (directory: string): WalkRefusal | null => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return { error: "that folder could not be read" };
    }
    for (const entry of entries.sort()) {
      if (SKIPPED_ENTRIES.has(entry)) continue;
      const absolute = join(directory, entry);
      let stats;
      try {
        stats = lstatSync(absolute);
      } catch {
        continue;
      }
      // Symlinks are skipped outright, in either direction: following one
      // could copy bytes from outside the reviewed tree.
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        const refusal = walk(absolute);
        if (refusal) return refusal;
        continue;
      }
      if (!stats.isFile()) continue;
      if (files.length >= MAX_ENTRIES) return { error: "that folder has too many files to be an extension" };
      total += stats.size;
      if (total > UNPACKED_MAX_BYTES) return { error: "that folder is too large to be an extension" };
      let bytes: Buffer;
      try {
        bytes = readFileSync(absolute);
      } catch {
        continue;
      }
      files.push({ path: relative(root, absolute).split(sep).join("/"), bytes });
    }
    return null;
  };

  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch {
    return { error: "that folder does not exist" };
  }
  if (!rootStats.isDirectory()) return { error: "that path is not a folder" };

  const refusal = walk(root);
  if (refusal) return refusal;
  if (!files.length) return { error: "that folder is empty" };
  return files;
}

/**
 * One hash over a whole extension tree.
 *
 * Paths are sorted and posix-separated, and each entry folds in both its
 * path and a hash of its bytes, so a rename is as detectable as an edit.
 * The exact byte layout is `${path}\0${sha256hex(bytes)}\n` per file, in
 * sorted path order.
 *
 * IMPORTANT: electron/browser-extensions.cjs recomputes this independently
 * before loading an extension. Both implementations must agree exactly —
 * change one and you must change the other, or every extension stops
 * loading with a hash mismatch.
 */
/** Code-point order, never locale order: the Electron side sorts the same
 * way, and a locale-aware sort would make the two hashes disagree. */
function comparePaths(a: ExtensionFile, b: ExtensionFile): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

export function hashExtensionFiles(files: ExtensionFile[]): string {
  const digest = createHash("sha256");
  for (const file of [...files].sort(comparePaths)) {
    const inner = createHash("sha256").update(file.bytes).digest("hex");
    digest.update(`${file.path}\0${inner}\n`);
  }
  return digest.digest("hex");
}

/** The same hash, computed by re-reading a directory. Returns null when the
 * tree cannot be read under the same rules the install used. */
export function hashExtensionDir(root: string): string | null {
  const files = readUnpackedExtension(root);
  return "error" in files ? null : hashExtensionFiles(files);
}

// ── Chrome Web Store ─────────────────────────────────────────────────────
// Everything below turns "a person pasted a Web Store link" into the same
// ExtensionFile[] the folder path already produces, so the review, the tree
// hash, and the loader are shared and already tested.
//
// The security property that matters: we prove the bytes we unpacked were
// signed by the key whose hash IS the extension id the person asked for.
// Without that, a download is just bytes from a URL, and whoever answers
// that request chooses what runs inside every page a bot opens. The id
// check is the hard floor; the signature check on top proves the archive
// was not altered after it was signed.

/** A store id is 32 letters, a-p — the hex alphabet shifted by ten. */
const STORE_ID = /^[a-p]{32}$/;
/** "CRX3 SignedData" plus a NUL: the 16-byte prefix Chromium signs over. */
const SIGNED_DATA_PREFIX = Buffer.from("CRX3 SignedData\u0000", "utf8");
/** The archive equivalent of MAX_ENTRIES, kept in step with it. */
const MAX_ZIP_ENTRIES = MAX_ENTRIES;

export interface WebstoreSource {
  id: string;
  url: string;
}

/**
 * Accept what a person is likely to paste: a Web Store page URL (current or
 * legacy host), or a bare extension id.
 */
export function parseWebstoreSource(input: string): WebstoreSource | { error: string } {
  const text = String(input ?? "").trim();
  if (!text) return { error: "paste a Chrome Web Store link or an extension id" };

  if (STORE_ID.test(text)) {
    return { id: text, url: `https://chromewebstore.google.com/detail/${text}` };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: "that is not a Chrome Web Store link or an extension id" };
  }
  const host = url.hostname.toLowerCase();
  if (host !== "chromewebstore.google.com" && host !== "chrome.google.com") {
    return { error: "that link is not a Chrome Web Store page" };
  }

  // The id is the last path segment shaped like one, which covers both
  // /detail/<slug>/<id> and the older /webstore/detail/<slug>/<id>.
  const id = url.pathname.split("/").reverse().find((segment) => STORE_ID.test(segment));
  if (!id) return { error: "that store link has no extension id in it" };
  return { id, url: url.toString() };
}

/** Chromium's own update endpoint, asked for a direct CRX3 download. */
export function crxDownloadUrl(id: string, chromeVersion: string): string {
  const version = /^\d+(\.\d+){0,3}$/.test(chromeVersion) ? chromeVersion : "150.0.0.0";
  return "https://clients2.google.com/service/update2/crx"
    + "?response=redirect"
    + `&prodversion=${encodeURIComponent(version)}`
    + "&acceptformat=crx3"
    + `&x=${encodeURIComponent(`id=${id}&uc`)}`;
}

/**
 * Download one extension archive.
 *
 * The size cap is enforced while streaming, not after: a hostile or mistaken
 * response must not be buffered in full before we refuse it.
 */
export async function downloadCrx(
  id: string,
  chromeVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<Buffer | { error: string }> {
  if (!STORE_ID.test(id)) return { error: "that is not a valid extension id" };
  let response: Response;
  try {
    response = await fetcher(crxDownloadUrl(id, chromeVersion), {
      redirect: "follow",
      signal: AbortSignal.timeout(CRX_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    return { error: `could not reach the Chrome Web Store: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (response.status === 204 || response.status === 404) {
    return { error: "the Chrome Web Store has no extension with that id" };
  }
  if (!response.ok) return { error: `the Chrome Web Store answered ${response.status}` };

  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > CRX_MAX_BYTES) {
    return { error: "that extension is too large to install" };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const body = response.body;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > CRX_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { error: "that extension is too large to install" };
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > CRX_MAX_BYTES) return { error: "that extension is too large to install" };
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// ── CRX3 container ───────────────────────────────────────────────────────
// A CRX3 file is: "Cr24" | uint32le version | uint32le headerLength |
// protobuf CrxFileHeader | ZIP archive. We read only the three fields we
// need rather than pull in a protobuf runtime:
//   field 2      repeated AsymmetricKeyProof sha256_with_rsa
//   field 3      repeated AsymmetricKeyProof sha256_with_ecdsa
//   field 10000  bytes signed_header_data (a SignedData with crx_id at 1)
// AsymmetricKeyProof is { 1: public_key, 2: signature }.

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor]!;
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
    // Anything longer than this is not a length we are willing to honour.
    if (shift > 42) return null;
  }
  return null;
}

/** Every length-delimited field in one protobuf message, by field number.
 * Other wire types are skipped rather than treated as an error: an unknown
 * field is not a reason to refuse an otherwise valid archive. */
function lengthDelimitedFields(buffer: Buffer): Map<number, Buffer[]> {
  const fields = new Map<number, Buffer[]>();
  let cursor = 0;
  while (cursor < buffer.length) {
    const key = readVarint(buffer, cursor);
    if (!key) break;
    cursor = key.next;
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (wireType === 2) {
      const length = readVarint(buffer, cursor);
      if (!length) break;
      const start = length.next;
      const end = start + length.value;
      if (end > buffer.length) break;
      const list = fields.get(fieldNumber) ?? [];
      list.push(buffer.subarray(start, end));
      fields.set(fieldNumber, list);
      cursor = end;
      continue;
    }
    if (wireType === 0) {
      const skipped = readVarint(buffer, cursor);
      if (!skipped) break;
      cursor = skipped.next;
      continue;
    }
    if (wireType === 5) {
      cursor += 4;
      continue;
    }
    if (wireType === 1) {
      cursor += 8;
      continue;
    }
    break;
  }
  return fields;
}

export interface CrxProof {
  publicKey: Buffer;
  signature: Buffer;
}

export interface ParsedCrx {
  /** The 16 raw bytes the archive claims as its own id, if it declares one. */
  declaredId: Buffer | null;
  signedHeaderData: Buffer;
  rsaProofs: CrxProof[];
  ecdsaProofs: CrxProof[];
  zip: Buffer;
}

export function parseCrx3(buffer: Buffer): ParsedCrx | { error: string } {
  if (buffer.length < 16 || buffer.subarray(0, 4).toString("latin1") !== "Cr24") {
    return { error: "that download is not a Chrome extension archive" };
  }
  const version = buffer.readUInt32LE(4);
  if (version !== 3) return { error: `only CRX3 archives are supported, and this one is version ${version}` };
  const headerLength = buffer.readUInt32LE(8);
  const headerEnd = 12 + headerLength;
  if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerEnd > buffer.length) {
    return { error: "that extension archive is malformed" };
  }

  const header = lengthDelimitedFields(buffer.subarray(12, headerEnd));
  const proofsOf = (fieldNumber: number): CrxProof[] => (header.get(fieldNumber) ?? []).flatMap((raw) => {
    const proof = lengthDelimitedFields(raw);
    const publicKey = proof.get(1)?.[0];
    const signature = proof.get(2)?.[0];
    return publicKey && signature ? [{ publicKey, signature }] : [];
  });

  const signedHeaderData = header.get(10_000)?.[0];
  if (!signedHeaderData) return { error: "that extension archive carries no signed header" };
  const declaredId = lengthDelimitedFields(signedHeaderData).get(1)?.[0] ?? null;

  return {
    declaredId,
    signedHeaderData,
    rsaProofs: proofsOf(2),
    ecdsaProofs: proofsOf(3),
    zip: buffer.subarray(headerEnd),
  };
}

/** The a-p rendering of 16 raw id bytes, Chromium's own encoding. */
function idFromBytes(bytes: Buffer): string {
  let id = "";
  for (const byte of bytes) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/**
 * Chromium's extension id: the first 16 bytes of the key's sha256, with each
 * nibble written as a..p instead of 0..f.
 */
export function extensionIdFromPublicKey(publicKey: Buffer): string {
  return idFromBytes(createHash("sha256").update(publicKey).digest().subarray(0, 16));
}

/**
 * The hard floor. Find the proof whose public key hashes to the id the
 * person asked for, and hand that key back.
 *
 * Checking only the id the archive declares would be circular — whoever
 * produced the file chose that too. Binding to the REQUESTED id is what
 * makes the download the thing that was asked for. The declared id is
 * checked as well, so a self-inconsistent archive is refused rather than
 * quietly accepted.
 */
export function verifyCrxId(parsed: ParsedCrx, expectedId: string): Buffer | { error: string } {
  if (!STORE_ID.test(expectedId)) return { error: "that is not a valid extension id" };
  if (parsed.declaredId) {
    if (parsed.declaredId.length !== 16) return { error: "that extension archive declares a malformed id" };
    if (idFromBytes(parsed.declaredId) !== expectedId) {
      return { error: "that archive is signed for a different extension than the one you asked for" };
    }
  }
  for (const proof of [...parsed.rsaProofs, ...parsed.ecdsaProofs]) {
    if (extensionIdFromPublicKey(proof.publicKey) === expectedId) return proof.publicKey;
  }
  return { error: "that archive is not signed by the extension it claims to be" };
}

/**
 * Prove the archive was not altered after signing.
 *
 * Chromium signs `"CRX3 SignedData\0" || uint32le(len) || signedHeaderData
 * || zip`. Only RSA proofs are verified: Node checks RSA-PKCS1v15-SHA256
 * against a DER SPKI key directly, and every Web Store extension carries an
 * RSA proof. An archive offering only ECDSA proofs is refused rather than
 * waved through unverified.
 */
export function verifyCrxSignature(parsed: ParsedCrx, publicKey: Buffer): true | { error: string } {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(parsed.signedHeaderData.length, 0);
  const signed = Buffer.concat([SIGNED_DATA_PREFIX, length, parsed.signedHeaderData, parsed.zip]);

  const matching = parsed.rsaProofs.filter((proof) => proof.publicKey.equals(publicKey));
  if (!matching.length) {
    return { error: "that archive has no RSA signature for its own key, so it cannot be verified" };
  }
  for (const proof of matching) {
    try {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(signed);
      verifier.end();
      if (verifier.verify({ key: publicKey, format: "der", type: "spki" }, proof.signature)) return true;
    } catch {
      // A key Node cannot parse is a failed verification, not a crash.
    }
  }
  return { error: "that extension archive's signature does not match its contents" };
}

/**
 * Unpack the ZIP payload under the same rules as the folder walk.
 *
 * Entry names are the dangerous part: an archive can name `../../etc/thing`
 * or an absolute path and, unchecked, escape the directory it is written
 * into. Names are validated here rather than at write time, so a hostile
 * archive is refused before anything touches disk.
 */
export function unzipSafely(zip: Buffer): ExtensionFile[] | { error: string } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch (cause) {
    return { error: `that extension archive could not be opened: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const files: ExtensionFile[] = [];
  let total = 0;
  for (const [rawName, bytes] of Object.entries(entries)) {
    // Directory entries arrive with a trailing slash and no content.
    if (!rawName || rawName.endsWith("/")) continue;
    const name = rawName.replace(/\\/g, "/");
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
      return { error: "that extension archive contains an absolute path" };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return { error: "that extension archive contains an invalid file name" };
    const parts = name.split("/");
    if (parts.some((segment) => segment === "..")) {
      return { error: "that extension archive tries to write outside its own folder" };
    }
    if (parts.some((segment) => SKIPPED_ENTRIES.has(segment))) continue;
    if (files.length >= MAX_ZIP_ENTRIES) return { error: "that extension archive has too many files" };
    total += bytes.byteLength;
    if (total > UNPACKED_MAX_BYTES) return { error: "that extension is too large to install" };
    files.push({ path: name, bytes: Buffer.from(bytes) });
  }
  if (!files.length) return { error: "that extension archive is empty" };
  return files;
}

/**
 * Write the verified public key into the manifest as `key`.
 *
 * Chromium derives an unpacked extension's runtime id from this field, and
 * falls back to hashing the install path when it is absent. Without it, a
 * store extension gets a different id on every install and never matches
 * the id on its own store page — so nothing downstream can reason about its
 * identity, and an update could not be recognised as the same extension.
 *
 * Must run BEFORE the tree is hashed, so the recorded hash describes the
 * bytes that are actually loaded.
 */
export function injectManifestKey(files: ExtensionFile[], publicKey: Buffer): ExtensionFile[] | { error: string } {
  const index = files.findIndex((file) => file.path === "manifest.json");
  if (index < 0) return { error: "that extension archive has no manifest.json" };
  let manifest: unknown;
  try {
    manifest = JSON.parse(files[index]!.bytes.toString("utf8"));
  } catch {
    return { error: "that extension's manifest.json is not valid JSON" };
  }
  if (!isRecord(manifest)) return { error: "that extension's manifest.json must be a JSON object" };
  const withKey = { ...manifest, key: publicKey.toString("base64") };
  return files.map((file, position) => (
    position === index
      ? { path: file.path, bytes: Buffer.from(`${JSON.stringify(withKey, null, 2)}\n`, "utf8") }
      : file
  ));
}
