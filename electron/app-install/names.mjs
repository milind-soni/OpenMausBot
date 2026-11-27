// Names and identities of a saved app's launcher on this computer: what its file is called, which bundle or taskbar
// identity it carries, and the link it opens.
import { createHash } from "node:crypto";

export { launcherLink, validAppId } from "../app-link.mjs";

export const FOLDER_NAME = "MausBot Apps";
export const HOST_BUNDLE_ID = "com.openmausbot.app";

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;

export const validBundleId = (id) => typeof id === "string" && BUNDLE_ID.test(id) && !id.includes("..");

export const appKey = (id) => createHash("sha256").update(`openmausbot-local-app\n${id}`).digest("hex").slice(0, 16);

export const launcherBundleId = (id, host = HOST_BUNDLE_ID) => `${validBundleId(host) ? host : HOST_BUNDLE_ID}.localapp.${appKey(id)}`;

/** Windows groups taskbar buttons and pinned shortcuts by this id; a window that sets it with `setAppDetails` gets a
 * button of its own. */
export const windowsAppUserModelId = (id) => `${HOST_BUNDLE_ID}.localapp.${appKey(id)}`;

const RESERVED_WINDOWS = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const MAX_GRAPHEMES = 64;
const MAX_BYTES = 180;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function shorten(name) {
  let out = "";
  let count = 0;
  for (const { segment } of segmenter.segment(name)) {
    if (count === MAX_GRAPHEMES || Buffer.byteLength(out + segment) > MAX_BYTES) break;
    out += segment;
    count += 1;
  }
  return out;
}

/**
 * One file name that every target file system accepts: no control, bidirectional-override or zero-width characters,
 * none of `\ / : * ? " < > |`, no leading dot (hidden), no trailing dot or space (Windows drops them), no reserved
 * Windows device name, at most 64 characters and 180 UTF-8 bytes. Never empty.
 */
export function launcherName(raw) {
  let name = (typeof raw === "string" ? raw : "").normalize("NFC")
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+/u, "");
  name = shorten(name).replace(/[.\s]+$/u, "");
  const dot = name.indexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  if (RESERVED_WINDOWS.test(stem.trimEnd())) name = `${stem.trimEnd()}_${dot === -1 ? "" : name.slice(dot)}`;
  return name || "App";
}

/** macOS and Windows compare file names without case and, on macOS, without Unicode normalisation form. */
export const nameKey = (name) => name.normalize("NFD").toLocaleLowerCase("en-US");

/** `base`, then `base 2`, `base 3`… until `free(candidate)` says yes; null when none of 99 is free. */
export async function firstFreeName(base, free) {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (await free(candidate)) return candidate;
  }
  return null;
}
