const fs = require("node:fs");
const path = require("node:path");

const LOCALES_DIR = path.join(__dirname, "..", "src", "locales");
const LOCALE_FILE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*\.json$/;
const SOURCE_HASHES = "source-hashes.json";
const ENGLISH = "en";
const LOCALE_ALIASES = Object.freeze({ pt: "pt-br", "zh-hant": "zh-tw", "zh-hk": "zh-tw", "zh-mo": "zh-tw" });
const SHARED_KEYS = new Set(["place.local", "rail.thisComputer", "rail.remove", "cloudHome.tryAgain", "computer.windows.start", "mcp.turnOn", "cloudSetup.myCloud", "computer.badge.local", "room.aBot"]);
const kept = (key) => key.startsWith("native.") || key.startsWith("teamMove.") || SHARED_KEYS.has(key);

/** Security: a language is only ever a pack file listed here; a code from a page never reaches a path unchecked. */
function localeCodes(dir = LOCALES_DIR, files = fs) {
  try {
    return new Set(files.readdirSync(dir).filter((name) => LOCALE_FILE.test(name) && name !== SOURCE_HASHES).map((name) => name.slice(0, -".json".length)));
  } catch {
    return new Set();
  }
}

function resolveLanguage(tag, codes) {
  if (typeof tag !== "string") return null;
  let candidate = tag.trim().toLowerCase().replaceAll("_", "-");
  while (candidate) {
    const code = Object.hasOwn(LOCALE_ALIASES, candidate) ? LOCALE_ALIASES[candidate] : candidate;
    if (codes.has(code)) return code;
    const cut = candidate.lastIndexOf("-");
    if (cut < 0) break;
    candidate = candidate.slice(0, cut);
  }
  return null;
}

function readPack(dir, code, files) {
  try {
    const all = JSON.parse(files.readFileSync(path.join(dir, `${code}.json`), "utf8"));
    return Object.fromEntries(Object.entries(all).filter(([key, value]) => kept(key) && typeof value === "string"));
  } catch {
    return {};
  }
}

function fill(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}

const intlTagOf = (code) => code.split("-").map((part, index) => (index === 0 ? part
  : part.length === 2 ? part.toUpperCase() : part.length === 4 ? part[0].toUpperCase() + part.slice(1) : part)).join("-");

function createNativeText({ dir = LOCALES_DIR, saved = null, system = () => "", files = fs } = {}) {
  let codes = null;
  const available = () => (codes ??= localeCodes(dir, files));
  const packs = new Map();
  const pack = (code) => {
    if (!packs.has(code)) packs.set(code, readPack(dir, code, files));
    return packs.get(code);
  };
  const systemTag = () => {
    try { return String(system() ?? ""); } catch { return ""; }
  };
  let chosen = resolveLanguage(saved, available()), shown = null;
  // With nothing picked, the language the window's page shows (follow), so menus never read in another one beside it.
  const language = () => chosen ?? shown ?? resolveLanguage(systemTag(), available()) ?? ENGLISH;
  const intlTag = () => {
    const code = language(), tag = systemTag();
    if (tag && resolveLanguage(tag, available()) === code) {
      try { return Intl.getCanonicalLocales(tag)[0]; } catch {}
    }
    return intlTagOf(code);
  };
  return {
    language,
    t(key, params) {
      const own = pack(language())[key];
      return fill(own ?? pack(ENGLISH)[key] ?? key, params);
    },
    set(code) {
      const before = language();
      chosen = resolveLanguage(code, available());
      return language() !== before;
    },
    /** The window's page shows `code`: main's words follow it while nothing is picked. True when they change. */
    follow(code) {
      const before = language();
      shown = resolveLanguage(code, available());
      return language() !== before;
    },
    intlTag,
    listFormat(names) {
      if (language() !== ENGLISH) return new Intl.ListFormat(intlTag(), { type: "conjunction" }).format(names);
      return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
    },
  };
}

const englishText = createNativeText({ saved: ENGLISH });

const listed = new Map();
function nativeLanguage(code, dir = LOCALES_DIR) {
  if (!listed.has(dir)) listed.set(dir, localeCodes(dir));
  return resolveLanguage(code, listed.get(dir));
}

module.exports = { LOCALE_ALIASES, LOCALES_DIR, createNativeText, englishText, nativeLanguage, resolveLanguage };
