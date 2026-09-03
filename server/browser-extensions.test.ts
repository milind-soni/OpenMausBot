import crypto, { createHash, type KeyObject } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";

import {
  CRX_MAX_BYTES,
  crxDownloadUrl,
  downloadCrx,
  extensionIdFromPublicKey,
  hashExtensionDir,
  hashExtensionFiles,
  injectManifestKey,
  MAX_ENTRIES,
  parseCrx3,
  parseExtensionManifest,
  parseWebstoreSource,
  readUnpackedExtension,
  unzipSafely,
  verifyCrxId,
  verifyCrxSignature,
  type ExtensionFile,
  type ParsedCrx,
} from "./browser-extension-crx.ts";
import {
  browserExtensionsRevision,
  enabledBrowserExtensions,
  installBrowserExtensionFromFolder,
  installBrowserExtensionFromWebstore,
  listBrowserExtensions,
  MAX_BROWSER_EXTENSIONS,
  readBrowserExtensionManifest,
  removeBrowserExtension,
  setBrowserExtensionEnabled,
} from "./browser-extensions.ts";
import { DATA_DIR } from "./config.ts";

const FIXTURE = join(import.meta.dirname, "testing", "fixtures", "mv3-extension");

let scratch: string;

/** A throwaway copy of the fixture, so a test can edit it without touching
 * the checked-in tree. `overrides` replaces or adds files by relative path. */
function makeExtension(overrides: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(scratch, "ext-"));
  cpSync(FIXTURE, root, { recursive: true });
  for (const [relative, contents] of Object.entries(overrides)) {
    const target = join(root, ...relative.split("/"));
    if (contents === null) {
      rmSync(target, { force: true, recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0", ...extra });
}

/** Parse a manifest object without touching disk. */
function factsFor(extra: Record<string, unknown> = {}) {
  return parseExtensionManifest([{ path: "manifest.json", bytes: Buffer.from(manifest(extra)) }]);
}

// ── a real, signed CRX3, built in the test ───────────────────────────────
// Downloading a fixture from the store would make the suite depend on the
// network and on Google not changing a build. Signing one here with a
// throwaway key exercises the same parser and the same verification, and
// lets a test ask for archives that are deliberately wrong.

/** protobuf: one length-delimited field. */
function field(fieldNumber: number, payload: Buffer): Buffer {
  const key = varint(fieldNumber * 8 + 2);
  return Buffer.concat([key, varint(payload.length), payload]);
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte += 128;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

interface SignedCrxOptions {
  key?: { publicKey: KeyObject; privateKey: KeyObject };
  version?: string;
  permissions?: string[];
  /** Claim an id the signing key does not produce. */
  declaredId?: Buffer;
  /** Sign properly, but file the proof under the ECDSA field. */
  rsaAsEcdsa?: boolean;
  /** Emit no key proofs at all. */
  omitProofs?: boolean;
}

function signedCrx(options: SignedCrxOptions = {}): {
  buffer: Buffer;
  id: string;
  publicKey: Buffer;
  privateKey: { publicKey: KeyObject; privateKey: KeyObject };
} {
  const pair = options.key ?? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const id = extensionIdFromPublicKey(publicKey);

  const zip = Buffer.from(zipSync({
    "manifest.json": Buffer.from(JSON.stringify({
      manifest_version: 3,
      name: "Signed Fixture",
      version: options.version ?? "1.0.0",
      ...(options.permissions ? { permissions: options.permissions } : {}),
      content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"] }],
    })),
    "content.js": Buffer.from("// fixture"),
  }));

  // SignedData { bytes crx_id = 1 }
  const declaredId = options.declaredId
    ?? createHash("sha256").update(publicKey).digest().subarray(0, 16);
  const signedHeaderData = field(1, declaredId);

  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length, 0);
  const signed = Buffer.concat([
    Buffer.from("CRX3 SignedData\u0000", "utf8"),
    length,
    signedHeaderData,
    zip,
  ]);
  const signature = crypto.sign("sha256", signed, pair.privateKey);

  // AsymmetricKeyProof { 1: public_key, 2: signature }
  const proof = Buffer.concat([field(1, publicKey), field(2, signature)]);
  const proofField = options.rsaAsEcdsa ? 3 : 2;
  const header = Buffer.concat([
    ...(options.omitProofs ? [] : [field(proofField, proof)]),
    field(10_000, signedHeaderData),
  ]);

  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "latin1");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);

  return { buffer: Buffer.concat([prefix, header, zip]), id, publicKey, privateKey: pair };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "omb-ext-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(join(DATA_DIR, "browser-extensions.json"), { force: true });
  rmSync(join(DATA_DIR, "browser-extensions"), { recursive: true, force: true });
});

describe("parseExtensionManifest", () => {
  it("reads the facts a review dialog needs", () => {
    const facts = factsFor({
      permissions: ["storage", "scripting"],
      host_permissions: ["https://example.com/*"],
      content_scripts: [{ matches: ["https://example.com/*"], js: ["c.js"] }],
    });
    expect(facts).toMatchObject({
      name: "Fixture",
      version: "1.0.0",
      manifestVersion: 3,
      permissions: ["storage", "scripting"],
      hasContentScripts: true,
      hasBackground: false,
      hasAction: false,
    });
  });

  it("refuses a manifest that is missing, malformed, or the wrong shape", () => {
    expect(parseExtensionManifest([])).toEqual({ error: expect.stringContaining("no manifest.json") });
    expect(parseExtensionManifest([{ path: "manifest.json", bytes: Buffer.from("{oops") }]))
      .toEqual({ error: expect.stringContaining("not valid JSON") });
    expect(parseExtensionManifest([{ path: "manifest.json", bytes: Buffer.from("[]") }]))
      .toEqual({ error: expect.stringContaining("JSON object") });
  });

  it("refuses manifest versions other than 2 and 3", () => {
    expect(factsFor({ manifest_version: 1 })).toEqual({ error: expect.stringContaining("Manifest V2 and V3") });
  });

  it("requires a name and a plausible version", () => {
    expect(factsFor({ name: "  " })).toEqual({ error: expect.stringContaining("needs a name") });
    expect(factsFor({ version: "not-a-version" })).toEqual({ error: expect.stringContaining("version like") });
  });

  it("refuses permissions that fight the browser's security model, and says why", () => {
    for (const permission of ["nativeMessaging", "proxy", "management", "downloads", "tabCapture", "desktopCapture"]) {
      expect(factsFor({ permissions: [permission] })).toEqual({ error: expect.stringContaining(permission) });
    }
  });

  it("refuses a fighting permission even when it is only optional", () => {
    // An extension that can request it at runtime can reach it at runtime.
    expect(factsFor({ optional_permissions: ["nativeMessaging"] }))
      .toEqual({ error: expect.stringContaining("nativeMessaging") });
  });

  it("refuses debugger, which would fight the CDP session the bot drives", () => {
    const refusal = factsFor({ permissions: ["debugger"] });
    expect(refusal).toEqual({ error: expect.stringContaining("debugger") });
    expect((refusal as { error: string }).error).toContain("bot drives the page with");
  });

  it("warns rather than refuses for APIs that merely do not work", () => {
    // The distinction this whole module turns on: "will not work" is a
    // sentence in the review dialog, not a refusal.
    const facts = factsFor({ permissions: ["declarativeNetRequest", "sidePanel", "identity"] });
    expect(facts).not.toHaveProperty("error");
    const { warnings } = facts as { warnings: string[] };
    expect(warnings.join(" ")).toContain("declarativeNetRequest");
    expect(warnings.join(" ")).toContain("side panel");
    expect(warnings.join(" ")).toContain("sign-in");
  });

  it("warns that our own network policy wins over chrome.webRequest", () => {
    const { warnings } = factsFor({ permissions: ["webRequest"] }) as { warnings: string[] };
    expect(warnings.join(" ")).toContain("takes precedence");
  });

  it("warns about a toolbar popup the built-in browser cannot show", () => {
    const facts = factsFor({ action: { default_popup: "popup.html" } }) as { warnings: string[]; hasAction: boolean };
    expect(facts.hasAction).toBe(true);
    expect(facts.warnings.join(" ")).toContain("toolbar popup");
  });

  it("warns about a background service worker and its broken storage events", () => {
    const { warnings } = factsFor({ background: { service_worker: "bg.js" } }) as { warnings: string[] };
    expect(warnings.join(" ")).toContain("storage change events do not reach it");
  });

  it("warns loudly when the extension runs on every page", () => {
    for (const pattern of ["<all_urls>", "*://*/*", "https://*/*"]) {
      const { warnings } = factsFor({ host_permissions: [pattern] }) as { warnings: string[] };
      expect(warnings.join(" ")).toContain("every page any bot opens");
    }
  });

  it("treats MV2 host patterns in permissions as host permissions", () => {
    // MV2 mixed hosts and APIs in one list; both manifest versions must
    // present the reviewer with the same two lists.
    const facts = factsFor({ manifest_version: 2, permissions: ["storage", "https://example.com/*"] }) as {
      permissions: string[];
      hostPermissions: string[];
      warnings: string[];
    };
    expect(facts.permissions).toEqual(["storage"]);
    expect(facts.hostPermissions).toEqual(["https://example.com/*"]);
    expect(facts.warnings.join(" ")).toContain("Manifest V2");
  });

  it("folds content-script matches into the host list a person reviews", () => {
    const facts = factsFor({ content_scripts: [{ matches: ["https://intranet.example/*"], js: ["c.js"] }] }) as {
      hostPermissions: string[];
    };
    expect(facts.hostPermissions).toContain("https://intranet.example/*");
  });

  it("resolves a __MSG_ name from the extension's own locale files", () => {
    const facts = parseExtensionManifest([
      { path: "manifest.json", bytes: Buffer.from(manifest({ name: "__MSG_extName__", default_locale: "en" })) },
      { path: "_locales/en/messages.json", bytes: Buffer.from(JSON.stringify({ extName: { message: "Real Name" } })) },
    ]);
    expect(facts).toMatchObject({ name: "Real Name" });
  });

  it("falls back to the raw placeholder when the locale file is unusable", () => {
    const facts = parseExtensionManifest([
      { path: "manifest.json", bytes: Buffer.from(manifest({ name: "__MSG_extName__" })) },
      { path: "_locales/en/messages.json", bytes: Buffer.from("{broken") },
    ]);
    expect(facts).toMatchObject({ name: "__MSG_extName__" });
  });

  it("warns when an extension would do nothing at all", () => {
    const { warnings } = factsFor() as { warnings: string[] };
    expect(warnings.join(" ")).toContain("may do nothing");
  });
});

describe("readUnpackedExtension", () => {
  it("reads a real folder, posix-separating every path", () => {
    const files = readUnpackedExtension(makeExtension()) as Array<{ path: string }>;
    expect(files.map((file) => file.path).sort()).toEqual([
      "content.js",
      "icons/icon-16.png",
      "manifest.json",
    ]);
  });

  it("refuses a missing path, a file, and an empty folder", () => {
    expect(readUnpackedExtension(join(scratch, "nope"))).toEqual({ error: expect.stringContaining("does not exist") });
    const file = join(scratch, "a-file");
    writeFileSync(file, "x");
    expect(readUnpackedExtension(file)).toEqual({ error: expect.stringContaining("not a folder") });
    const empty = mkdtempSync(join(scratch, "empty-"));
    expect(readUnpackedExtension(empty)).toEqual({ error: expect.stringContaining("empty") });
  });

  it("never follows a symlink, even one pointing outside the tree", () => {
    // A link is how a reviewed tree smuggles in bytes nobody looked at.
    const secret = join(scratch, "secret.txt");
    writeFileSync(secret, "do not copy me");
    const root = makeExtension();
    symlinkSync(secret, join(root, "linked.txt"));
    const files = readUnpackedExtension(root) as Array<{ path: string }>;
    expect(files.map((file) => file.path)).not.toContain("linked.txt");
  });

  it("skips the noise directories Chrome ignores too", () => {
    const root = makeExtension({ ".git/config": "[core]", "node_modules/pkg/index.js": "x", ".DS_Store": "x" });
    const files = readUnpackedExtension(root) as Array<{ path: string }>;
    expect(files.map((file) => file.path).join(" ")).not.toMatch(/\.git|node_modules|DS_Store/);
  });

  it("keeps Chrome's _metadata directory out of the hash, because Chromium deletes it on load", () => {
    // Every store archive ships _metadata/verified_contents.json. Including it
    // made the hash pass at install and enable, then fail forever after the
    // first load — the extension showed as tampered and never ran again.
    const root = makeExtension({ "_metadata/verified_contents.json": "[]" });
    const files = readUnpackedExtension(root) as Array<{ path: string }>;
    expect(files.map((file) => file.path)).not.toContain("_metadata/verified_contents.json");
    const withIt = hashExtensionDir(root);
    rmSync(join(root, "_metadata"), { recursive: true, force: true });
    expect(hashExtensionDir(root)).toBe(withIt);
  });

  it("refuses a folder with too many files to be an extension", () => {
    const root = makeExtension();
    const many = join(root, "many");
    mkdirSync(many, { recursive: true });
    for (let n = 0; n <= MAX_ENTRIES; n += 1) writeFileSync(join(many, `f${n}.txt`), "x");
    expect(readUnpackedExtension(root)).toEqual({ error: expect.stringContaining("too many files") });
  });
});

describe("hashExtensionFiles", () => {
  it("is stable across file order", () => {
    const a = { path: "a.js", bytes: Buffer.from("a") };
    const b = { path: "b.js", bytes: Buffer.from("b") };
    expect(hashExtensionFiles([a, b])).toBe(hashExtensionFiles([b, a]));
  });

  it("changes when contents change and when a file is renamed", () => {
    const base = [{ path: "a.js", bytes: Buffer.from("a") }];
    expect(hashExtensionFiles(base)).not.toBe(hashExtensionFiles([{ path: "a.js", bytes: Buffer.from("A") }]));
    expect(hashExtensionFiles(base)).not.toBe(hashExtensionFiles([{ path: "b.js", bytes: Buffer.from("a") }]));
  });

  it("matches the documented byte layout, which Electron recomputes independently", () => {
    // electron/browser-extensions.cjs must produce this exact digest. If this
    // assertion is edited, that file has to change in the same commit.
    const files = [{ path: "a.js", bytes: Buffer.from("hello") }];
    const inner = createHash("sha256").update(Buffer.from("hello")).digest("hex");
    const expected = createHash("sha256").update(`a.js\0${inner}\n`).digest("hex");
    expect(hashExtensionFiles(files)).toBe(expected);
  });

  it("agrees with the directory variant", () => {
    const root = makeExtension();
    const files = readUnpackedExtension(root) as Array<{ path: string; bytes: Buffer }>;
    expect(hashExtensionDir(root)).toBe(hashExtensionFiles(files));
  });
});

describe("install, review, enable, remove", () => {
  it("installs a folder DISABLED, whatever the person does next", () => {
    const listing = installBrowserExtensionFromFolder(makeExtension()) as { enabled: boolean; id: string; intact: boolean };
    expect(listing.enabled).toBe(false);
    // A successful install must always be enableable. The recorded hash is
    // checked against what actually reached the disk, so an install that
    // reports success can never be one that can never be turned on.
    expect(listing.intact).toBe(true);
    expect(listing.id).toMatch(/^local-[0-9a-f]{12}$/);
    expect(listBrowserExtensions()).toHaveLength(1);
    expect(enabledBrowserExtensions()).toEqual([]);
  });

  it("refuses a relative path", () => {
    expect(installBrowserExtensionFromFolder("./somewhere")).toEqual({ error: expect.stringContaining("choose a folder") });
  });

  it("copies the bytes, so editing the source folder cannot change what runs", () => {
    const source = makeExtension();
    const listing = installBrowserExtensionFromFolder(source) as { id: string; version: string };
    writeFileSync(join(source, "content.js"), "// replaced after review");
    const copied = readFileSync(
      join(DATA_DIR, "browser-extensions", listing.id, listing.version, "content.js"),
      "utf8",
    );
    expect(copied).not.toContain("replaced after review");
    expect(listBrowserExtensions()[0]!.intact).toBe(true);
  });

  it("copies binary files without corrupting them", () => {
    // Icons are PNGs; a string round-trip would mangle them.
    const source = makeExtension();
    const listing = installBrowserExtensionFromFolder(source) as { id: string; version: string };
    const original = readFileSync(join(source, "icons", "icon-16.png"));
    const copied = readFileSync(join(DATA_DIR, "browser-extensions", listing.id, listing.version, "icons", "icon-16.png"));
    expect(copied.equals(original)).toBe(true);
  });

  it("enables an intact extension and exposes it to the loader", () => {
    const listing = installBrowserExtensionFromFolder(makeExtension()) as { id: string };
    const enabled = setBrowserExtensionEnabled(listing.id, true) as { enabled: boolean };
    expect(enabled.enabled).toBe(true);
    expect(enabledBrowserExtensions().map((entry) => entry.id)).toEqual([listing.id]);
  });

  it("refuses to enable when the installed files changed after review", () => {
    const listing = installBrowserExtensionFromFolder(makeExtension()) as { id: string; version: string };
    writeFileSync(join(DATA_DIR, "browser-extensions", listing.id, listing.version, "content.js"), "// tampered");
    expect(setBrowserExtensionEnabled(listing.id, true)).toEqual({
      error: expect.stringContaining("changed after review"),
    });
    expect(enabledBrowserExtensions()).toEqual([]);
  });

  it("un-enables and warns about an extension tampered with after it was enabled", () => {
    const listing = installBrowserExtensionFromFolder(makeExtension()) as { id: string; version: string };
    setBrowserExtensionEnabled(listing.id, true);
    writeFileSync(join(DATA_DIR, "browser-extensions", listing.id, listing.version, "content.js"), "// tampered");
    const [shown] = listBrowserExtensions();
    expect(shown!.enabled).toBe(false);
    expect(shown!.intact).toBe(false);
    expect(shown!.warnings.join(" ")).toContain("changed after review");
    expect(enabledBrowserExtensions()).toEqual([]);
  });

  it("can always be disabled, even when tampered with", () => {
    const listing = installBrowserExtensionFromFolder(makeExtension()) as { id: string; version: string };
    setBrowserExtensionEnabled(listing.id, true);
    writeFileSync(join(DATA_DIR, "browser-extensions", listing.id, listing.version, "content.js"), "// tampered");
    expect(setBrowserExtensionEnabled(listing.id, false)).toMatchObject({ enabled: false });
  });

  it("refuses the same folder twice", () => {
    const source = makeExtension();
    installBrowserExtensionFromFolder(source);
    expect(installBrowserExtensionFromFolder(source)).toEqual({ error: expect.stringContaining("already installed") });
  });

  it("refuses past the cap", () => {
    for (let n = 0; n < MAX_BROWSER_EXTENSIONS; n += 1) {
      expect(installBrowserExtensionFromFolder(makeExtension())).not.toHaveProperty("error");
    }
    expect(installBrowserExtensionFromFolder(makeExtension())).toEqual({
      error: expect.stringContaining(String(MAX_BROWSER_EXTENSIONS)),
    });
  });

  it("refuses an extension whose manifest fights the security model, leaving nothing behind", () => {
    const root = makeExtension({ "manifest.json": manifest({ permissions: ["nativeMessaging"] }) });
    expect(installBrowserExtensionFromFolder(root)).toEqual({ error: expect.stringContaining("nativeMessaging") });
    expect(listBrowserExtensions()).toEqual([]);
  });

  it("serves the reviewed manifest, pretty-printed, from the copy", () => {
    const listing = installBrowserExtensionFromFolder(makeExtension()) as { id: string };
    const text = readBrowserExtensionManifest(listing.id)!;
    expect(JSON.parse(text)).toMatchObject({ manifest_version: 3, name: "OpenMausBot Test Extension" });
    expect(text).toContain("\n  ");
  });

  it("returns nothing for an unknown or malformed id", () => {
    expect(readBrowserExtensionManifest("local-000000000000")).toBeNull();
    expect(readBrowserExtensionManifest("../../etc/passwd")).toBeNull();
    expect(setBrowserExtensionEnabled("../../etc/passwd", true)).toBeNull();
    expect(removeBrowserExtension("nope")).toBe(false);
  });

  it("removes the record and the copied files", () => {
    const listing = installBrowserExtensionFromFolder(makeExtension()) as { id: string };
    expect(removeBrowserExtension(listing.id)).toBe(true);
    expect(listBrowserExtensions()).toEqual([]);
    expect(() => readFileSync(join(DATA_DIR, "browser-extensions", listing.id, "1.0.0", "manifest.json"))).toThrow();
  });

  it("survives a corrupt state file instead of throwing", () => {
    installBrowserExtensionFromFolder(makeExtension());
    writeFileSync(join(DATA_DIR, "browser-extensions.json"), "{not json");
    expect(listBrowserExtensions()).toEqual([]);
  });

  it("skips one unreadable record and keeps the rest", () => {
    // Validate-with-skip: a bad row must not cost a person the whole list.
    installBrowserExtensionFromFolder(makeExtension());
    const path = join(DATA_DIR, "browser-extensions.json");
    const document = JSON.parse(readFileSync(path, "utf8")) as { extensions: unknown[] };
    document.extensions.unshift({ id: "local-zzz", name: 7 });
    writeFileSync(path, JSON.stringify(document));
    expect(listBrowserExtensions()).toHaveLength(1);
  });

  it("changes its revision only when the enabled set changes", () => {
    const listing = installBrowserExtensionFromFolder(makeExtension()) as { id: string };
    const installed = browserExtensionsRevision();
    expect(browserExtensionsRevision()).toBe(installed);
    setBrowserExtensionEnabled(listing.id, true);
    const enabled = browserExtensionsRevision();
    expect(enabled).not.toBe(installed);
    setBrowserExtensionEnabled(listing.id, false);
    expect(browserExtensionsRevision()).toBe(installed);
  });
});


describe("parseWebstoreSource", () => {
  const ID = "a".repeat(32);

  it("accepts a bare extension id", () => {
    expect(parseWebstoreSource(ID)).toEqual({ id: ID, url: `https://chromewebstore.google.com/detail/${ID}` });
  });

  it("accepts current and legacy store links", () => {
    expect(parseWebstoreSource(`https://chromewebstore.google.com/detail/dark-reader/${ID}`))
      .toMatchObject({ id: ID });
    expect(parseWebstoreSource(`https://chrome.google.com/webstore/detail/dark-reader/${ID}?hl=en`))
      .toMatchObject({ id: ID });
  });

  it("accepts the real Dark Reader link shape", () => {
    const id = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
    expect(parseWebstoreSource(`https://chromewebstore.google.com/detail/dark-reader/${id}`))
      .toMatchObject({ id });
  });

  it("refuses anything that is not a store link", () => {
    for (const input of ["", "   ", "not a url", "https://example.com/detail/" + ID, "https://chromewebstore.google.com/detail/no-id-here"]) {
      expect(parseWebstoreSource(input)).toHaveProperty("error");
    }
  });

  it("refuses an id that is the wrong shape", () => {
    // Store ids are a-p only; hex characters outside that range are not ids.
    expect(parseWebstoreSource("z".repeat(32))).toHaveProperty("error");
    expect(parseWebstoreSource("a".repeat(31))).toHaveProperty("error");
  });
});

describe("crxDownloadUrl", () => {
  it("asks the update service for a CRX3 by id", () => {
    const url = new URL(crxDownloadUrl("a".repeat(32), "150.0.7871.224"));
    expect(url.origin + url.pathname).toBe("https://clients2.google.com/service/update2/crx");
    expect(url.searchParams.get("acceptformat")).toBe("crx3");
    expect(url.searchParams.get("prodversion")).toBe("150.0.7871.224");
    expect(url.searchParams.get("x")).toBe(`id=${"a".repeat(32)}&uc`);
  });

  it("falls back when the Chromium version is unusable", () => {
    // Plain node has no process.versions.chrome; a bad value must not end up
    // in the query string.
    expect(crxDownloadUrl("a".repeat(32), "not-a-version")).toContain("prodversion=150.0.0.0");
  });
});

describe("CRX3 archives", () => {
  it("round-trips a genuinely signed archive", () => {
    const crx = signedCrx();
    const parsed = parseCrx3(crx.buffer);
    expect(parsed).not.toHaveProperty("error");
    const key = verifyCrxId(parsed as ParsedCrx, crx.id);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(verifyCrxSignature(parsed as ParsedCrx, key as Buffer)).toBe(true);
    const files = unzipSafely((parsed as ParsedCrx).zip);
    expect(files).not.toHaveProperty("error");
    expect((files as ExtensionFile[]).map((f) => f.path).sort()).toEqual(["content.js", "manifest.json"]);
  });

  it("derives the same id Chromium would", () => {
    const crx = signedCrx();
    expect(extensionIdFromPublicKey(crx.publicKey)).toBe(crx.id);
    expect(crx.id).toMatch(/^[a-p]{32}$/);
  });

  it("refuses a file that is not a CRX at all", () => {
    expect(parseCrx3(Buffer.from("hello world, not an extension"))).toHaveProperty("error");
    expect(parseCrx3(Buffer.alloc(4))).toHaveProperty("error");
  });

  it("refuses CRX2 and other versions", () => {
    const crx = signedCrx();
    const wrong = Buffer.from(crx.buffer);
    wrong.writeUInt32LE(2, 4);
    expect(parseCrx3(wrong)).toEqual({ error: expect.stringContaining("version 2") });
  });

  it("refuses a header length that runs past the file", () => {
    const crx = signedCrx();
    const wrong = Buffer.from(crx.buffer);
    wrong.writeUInt32LE(0xffffff, 8);
    expect(parseCrx3(wrong)).toEqual({ error: expect.stringContaining("malformed") });
  });

  it("refuses an archive signed for a different extension", () => {
    // The whole point of the id check: bytes that verify perfectly against
    // their own key are still refused when that key is not the one asked for.
    const crx = signedCrx();
    const parsed = parseCrx3(crx.buffer) as ParsedCrx;
    const other = "b".repeat(32);
    expect(verifyCrxId(parsed, other)).toEqual({ error: expect.stringContaining("different extension") });
  });

  it("refuses an archive whose declared id disagrees with its key", () => {
    const crx = signedCrx({ declaredId: Buffer.alloc(16, 0xcd) });
    const parsed = parseCrx3(crx.buffer) as ParsedCrx;
    expect(verifyCrxId(parsed, crx.id)).toEqual({ error: expect.stringContaining("different extension") });
  });

  it("refuses an archive with no proof matching the requested id", () => {
    const crx = signedCrx({ omitProofs: true });
    const parsed = parseCrx3(crx.buffer) as ParsedCrx;
    expect(verifyCrxId(parsed, crx.id)).toEqual({ error: expect.stringContaining("not signed by") });
  });

  it("detects a payload altered after signing", () => {
    // Flip a byte in the zip; the id check still passes, and only the
    // signature check catches it.
    const crx = signedCrx();
    const tampered = Buffer.from(crx.buffer);
    tampered[tampered.length - 40] ^= 0xff;
    const parsed = parseCrx3(tampered) as ParsedCrx;
    const key = verifyCrxId(parsed, crx.id);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(verifyCrxSignature(parsed, key as Buffer)).toEqual({ error: expect.stringContaining("does not match") });
  });

  it("refuses an archive offering only an ECDSA proof", () => {
    const crx = signedCrx({ rsaAsEcdsa: true });
    const parsed = parseCrx3(crx.buffer) as ParsedCrx;
    const key = verifyCrxId(parsed, crx.id);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(verifyCrxSignature(parsed, key as Buffer)).toEqual({ error: expect.stringContaining("no RSA signature") });
  });
});

describe("unzipSafely", () => {
  const zipOf = (entries: Record<string, string>): Buffer => Buffer.from(
    zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]))),
  );

  it("refuses an entry that escapes its own folder", () => {
    expect(unzipSafely(zipOf({ "manifest.json": "{}", "../evil.js": "x" })))
      .toEqual({ error: expect.stringContaining("outside its own folder") });
    expect(unzipSafely(zipOf({ "a/../../evil.js": "x" })))
      .toEqual({ error: expect.stringContaining("outside its own folder") });
  });

  it("refuses an absolute path", () => {
    expect(unzipSafely(zipOf({ "/etc/passwd": "x" })))
      .toEqual({ error: expect.stringContaining("absolute path") });
    expect(unzipSafely(zipOf({ "C:/windows/x.dll": "x" })))
      .toEqual({ error: expect.stringContaining("absolute path") });
  });

  it("normalises backslashes before judging the path", () => {
    // A Windows-style separator must not be a way around the traversal check.
    expect(unzipSafely(zipOf({ "a\\..\\..\\evil.js": "x" })))
      .toEqual({ error: expect.stringContaining("outside its own folder") });
  });

  it("skips the noise directories the folder walk skips, _metadata included", () => {
    const files = unzipSafely(zipOf({
      "manifest.json": "{}", ".git/config": "x", "node_modules/p/i.js": "y", "_metadata/verified_contents.json": "[]",
    }));
    expect((files as ExtensionFile[]).map((f) => f.path)).toEqual(["manifest.json"]);
  });

  it("refuses an empty or unreadable archive", () => {
    expect(unzipSafely(zipOf({}))).toHaveProperty("error");
    expect(unzipSafely(Buffer.from("not a zip"))).toHaveProperty("error");
  });
});

describe("injectManifestKey", () => {
  it("writes the key so the runtime id matches the store id", () => {
    const crx = signedCrx();
    const files = [
      { path: "manifest.json", bytes: Buffer.from('{"manifest_version":3,"name":"X","version":"1.0.0"}') },
    ];
    const keyed = injectManifestKey(files, crx.publicKey) as ExtensionFile[];
    const manifest = JSON.parse(keyed[0]!.bytes.toString("utf8"));
    expect(manifest.key).toBe(crx.publicKey.toString("base64"));
    expect(manifest.name).toBe("X");
  });

  it("refuses an archive with no manifest, or an unreadable one", () => {
    const key = Buffer.from("k");
    expect(injectManifestKey([{ path: "a.js", bytes: Buffer.from("x") }], key)).toHaveProperty("error");
    expect(injectManifestKey([{ path: "manifest.json", bytes: Buffer.from("{oops") }], key)).toHaveProperty("error");
    expect(injectManifestKey([{ path: "manifest.json", bytes: Buffer.from("[]") }], key)).toHaveProperty("error");
  });
});

describe("downloadCrx", () => {
  const ID = "a".repeat(32);
  const okResponse = (body: Buffer) => new Response(body, { status: 200 });

  it("returns the archive bytes", async () => {
    const fetcher = vi.fn(async () => okResponse(Buffer.from("Cr24payload"))) as unknown as typeof fetch;
    const result = await downloadCrx(ID, "150.0.0.0", fetcher);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).toString()).toBe("Cr24payload");
  });

  it("explains a missing extension rather than a bare status code", async () => {
    for (const status of [204, 404]) {
      const fetcher = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
      expect(await downloadCrx(ID, "150.0.0.0", fetcher))
        .toEqual({ error: expect.stringContaining("no extension with that id") });
    }
  });

  it("reports other failures with their status", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await downloadCrx(ID, "150.0.0.0", fetcher)).toEqual({ error: expect.stringContaining("503") });
  });

  it("refuses a declared size over the cap without reading the body", async () => {
    const fetcher = vi.fn(async () => new Response("x", {
      status: 200,
      headers: { "content-length": String(CRX_MAX_BYTES + 1) },
    })) as unknown as typeof fetch;
    expect(await downloadCrx(ID, "150.0.0.0", fetcher)).toEqual({ error: expect.stringContaining("too large") });
  });

  it("stops a body that grows past the cap mid-stream", async () => {
    // An honest content-length is not required; the cap is enforced while
    // streaming so an oversized response is never fully buffered.
    const chunk = new Uint8Array(1024 * 1024);
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk); },
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await downloadCrx(ID, "150.0.0.0", fetcher)).toEqual({ error: expect.stringContaining("too large") });
  });

  it("turns a network failure into a sentence", async () => {
    const fetcher = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await downloadCrx(ID, "150.0.0.0", fetcher)).toEqual({ error: expect.stringContaining("could not reach") });
  });

  it("refuses a malformed id before making any request", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await downloadCrx("../etc", "150.0.0.0", fetcher)).toHaveProperty("error");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("installing from the Chrome Web Store", () => {
  const crxFetcher = (crx: Buffer) => (vi.fn(async () => new Response(crx, { status: 200 })) as unknown as typeof fetch);

  it("installs a signed archive DISABLED, with the store id as its id", async () => {
    const crx = signedCrx();
    const installed = await installBrowserExtensionFromWebstore(crx.id, "150.0.0.0", crxFetcher(crx.buffer));
    expect(installed).toMatchObject({ id: crx.id, name: "Signed Fixture", version: "1.0.0", enabled: false });
    // Same invariant on the store path, where the file set comes from an
    // archive rather than a directory walk.
    expect((installed as { intact: boolean }).intact).toBe(true);
    expect(listBrowserExtensions()).toHaveLength(1);
    expect(enabledBrowserExtensions()).toEqual([]);
  });

  it("records where it came from and what it downloaded", async () => {
    const crx = signedCrx();
    await installBrowserExtensionFromWebstore(
      `https://chromewebstore.google.com/detail/fixture/${crx.id}`,
      "150.0.0.0",
      crxFetcher(crx.buffer),
    );
    const [record] = listBrowserExtensions();
    expect(record!.source).toMatchObject({ type: "webstore" });
    expect(record!.crxSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes the manifest key, so the tree it hashed is the tree Chromium loads", async () => {
    const crx = signedCrx();
    const installed = await installBrowserExtensionFromWebstore(crx.id, "150.0.0.0", crxFetcher(crx.buffer)) as { id: string; version: string };
    const manifest = JSON.parse(
      readFileSync(join(DATA_DIR, "browser-extensions", installed.id, installed.version, "manifest.json"), "utf8"),
    );
    expect(manifest.key).toBe(crx.publicKey.toString("base64"));
    // And the recorded hash still describes what is on disk.
    expect(listBrowserExtensions()[0]!.intact).toBe(true);
  });

  it("refuses an archive that does not belong to the requested id", async () => {
    const crx = signedCrx();
    const other = "b".repeat(32);
    const result = await installBrowserExtensionFromWebstore(other, "150.0.0.0", crxFetcher(crx.buffer));
    expect(result).toEqual({ error: expect.stringContaining("different extension") });
    expect(listBrowserExtensions()).toEqual([]);
  });

  it("refuses an archive altered after signing", async () => {
    const crx = signedCrx();
    const tampered = Buffer.from(crx.buffer);
    tampered[tampered.length - 40] ^= 0xff;
    const result = await installBrowserExtensionFromWebstore(crx.id, "150.0.0.0", crxFetcher(tampered));
    expect(result).toEqual({ error: expect.stringContaining("signature does not match") });
    expect(listBrowserExtensions()).toEqual([]);
  });

  it("applies the same manifest gate as a folder install", async () => {
    const crx = signedCrx({ permissions: ["nativeMessaging"] });
    const result = await installBrowserExtensionFromWebstore(crx.id, "150.0.0.0", crxFetcher(crx.buffer));
    expect(result).toEqual({ error: expect.stringContaining("nativeMessaging") });
    expect(listBrowserExtensions()).toEqual([]);
  });

  it("refuses to reinstall over an enabled extension", async () => {
    const crx = signedCrx();
    const installed = await installBrowserExtensionFromWebstore(crx.id, "150.0.0.0", crxFetcher(crx.buffer)) as { id: string };
    setBrowserExtensionEnabled(installed.id, true);
    const again = await installBrowserExtensionFromWebstore(crx.id, "150.0.0.0", crxFetcher(crx.buffer));
    expect(again).toEqual({ error: expect.stringContaining("already installed") });
  });

  it("reinstalls a disabled extension and lands disabled again", async () => {
    // A new build must be reviewed before it runs, not inherit the old
    // decision.
    const first = signedCrx();
    await installBrowserExtensionFromWebstore(first.id, "150.0.0.0", crxFetcher(first.buffer));
    const second = signedCrx({ key: first.privateKey, version: "2.0.0" });
    const result = await installBrowserExtensionFromWebstore(second.id, "150.0.0.0", crxFetcher(second.buffer));
    expect(result).toMatchObject({ version: "2.0.0", enabled: false });
    expect(listBrowserExtensions()).toHaveLength(1);
    // the superseded version's directory is gone
    expect(existsSync(join(DATA_DIR, "browser-extensions", first.id, "1.0.0"))).toBe(false);
  });

  it("refuses a store install past the cap", async () => {
    for (let n = 0; n < MAX_BROWSER_EXTENSIONS; n += 1) {
      expect(installBrowserExtensionFromFolder(makeExtension())).not.toHaveProperty("error");
    }
    const crx = signedCrx();
    expect(await installBrowserExtensionFromWebstore(crx.id, "150.0.0.0", crxFetcher(crx.buffer)))
      .toEqual({ error: expect.stringContaining(String(MAX_BROWSER_EXTENSIONS)) });
  });

  it("refuses input that is not a store link at all", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await installBrowserExtensionFromWebstore("not a link", "150.0.0.0", fetcher)).toHaveProperty("error");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
