import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkCatalogs,
  main,
  recordSourceHashes,
  modelInvocation,
  normalizeLocaleCode,
  parseModelCatalog,
  placeholders,
  sourceHash,
  staleTranslationKeys,
  validateSourceCatalog,
  validateTranslationCatalog,
  validateTranslationHashes,
  writeTextAtomically,
} from "./generate-locale.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-locale-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("locale draft validation", () => {
  it("accepts every shipped catalog", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(() => checkCatalogs()).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("normalizes locale ids to stable lowercase filenames", () => {
    expect(normalizeLocaleCode("pt-BR")).toBe("pt-br");
    expect(normalizeLocaleCode("ZH-hant-TW")).toBe("zh-hant-tw");
    expect(() => normalizeLocaleCode("../fr")).toThrow(/unsupported locale code/i);
  });

  it("requires a non-empty flat English catalog", () => {
    expect(validateSourceCatalog({ hello: "Hello" })).toEqual([]);
    expect(validateSourceCatalog({ empty: "" })).toEqual([
      "empty: English value must be a non-empty string",
    ]);
    expect(validateSourceCatalog([])).toEqual(["English source must be a JSON object"]);
  });

  it("preserves the exact placeholder multiset while allowing reordered text", () => {
    const source = { hello: "Hello {name}; ask {name} about {count}" };
    expect(placeholders(source.hello)).toEqual(["count", "name", "name"]);
    expect(validateTranslationCatalog(source, {
      hello: "{count} Fragen für {name}; hallo {name}",
    })).toEqual([]);
    expect(validateTranslationCatalog(source, {
      hello: "Hallo {name}; {count}",
    })).toEqual([
      'hello: placeholders must stay ["count","name","name"] (received ["count","name"])',
    ]);
  });

  it("allows partial community packs but requires complete model drafts", () => {
    const source = { first: "One", second: "Two" };
    expect(validateTranslationCatalog(source, { first: "Uno" })).toEqual([]);
    expect(validateTranslationCatalog(source, { first: "Uno" }, { requireComplete: true })).toEqual([
      "second: translation is missing",
    ]);
  });

  it("rejects unknown, empty, and chatty model output", () => {
    const source = { first: "One" };
    expect(validateTranslationCatalog(source, { invented: "No", first: "" })).toEqual([
      "invented: key does not exist in English",
      "first: translation must be a non-empty string",
    ]);
    expect(parseModelCatalog('{"first":"Uno"}')).toEqual({ first: "Uno" });
    expect(() => parseModelCatalog('Here you go:\n{"first":"Uno"}')).toThrow(/exactly one JSON object/i);
  });

  it("treats a translation without a recorded hash as current and a changed English source as stale", () => {
    const source = { first: "One", second: "Two" };
    const translation = { first: "Uno" };
    const hashes = { first: sourceHash(source.first) };

    expect(validateTranslationHashes(source, translation, hashes)).toEqual([]);
    expect(staleTranslationKeys(source, translation, hashes)).toEqual(["second"]);

    const changedSource = { ...source, first: "One changed" };
    expect(validateTranslationHashes(changedSource, translation, hashes)).toEqual([
      "first: English source changed; refresh the translation or remove it for English fallback",
    ]);
    expect(staleTranslationKeys(changedSource, translation, hashes)).toEqual(["first", "second"]);
    expect(validateTranslationHashes(source, translation, {})).toEqual([]);
    expect(staleTranslationKeys(source, translation, {})).toEqual(["second"]);
  });

  it("ignores hashes of keys removed from English or from the translation", () => {
    const source = { first: "One" };
    const hashes = { first: sourceHash("One"), gone: sourceHash("Gone"), untranslated: sourceHash("Later") };
    expect(validateTranslationHashes(source, { first: "Uno" }, hashes)).toEqual([]);
  });

  it("builds an explicit no-tools restricted Claude invocation", () => {
    const claude = modelInvocation("darwin");
    expect(claude.command).toBe("claude");
    expect(claude.args).toContain("--safe-mode");
    expect(claude.args).toContain("--restricted");
    expect(claude.args).toContain("--tools");
    expect(claude.args.at(claude.args.indexOf("--tools") + 1)).toBe("");
    expect(claude.args).toContain("--no-session-persistence");

    const windows = modelInvocation("win32", "C:\\Windows\\System32\\cmd.exe");
    expect(windows.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windows.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(windows.args[3]).toContain('--tools ""');
    expect(windows.args[3]).not.toContain("One");
  });

  it("lets structural validation report null catalogs without a hash crash", () => {
    const source = { first: "One" };
    expect(validateTranslationCatalog(source, null)).toEqual(["translation must be a JSON object"]);
    expect(validateTranslationHashes(source, null, {})).toEqual([]);
  });

  it("replaces files atomically on the Windows code path", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "catalog.json");
    writeFileSync(path, "before");

    writeTextAtomically(path, "after", "win32");

    expect(readFileSync(path, "utf8")).toBe("after");
    expect(readdirSync(directory)).toEqual(["catalog.json"]);
  });

  it("never generates or accepts the English source catalog", () => {
    expect(() => main(["en", "English", "--force"])).toThrow(/English is the source catalog/i);
    expect(() => main(["en", "--accept"])).toThrow(/English is the source catalog/i);
  });
});

describe("locale catalogs on disk", () => {
  function locales({ en, catalogs, hashes }) {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "en.json"), JSON.stringify(en));
    for (const [code, catalog] of Object.entries(catalogs)) {
      writeFileSync(join(directory, `${code}.json`), JSON.stringify(catalog));
    }
    writeFileSync(join(directory, "source-hashes.json"), `${JSON.stringify({ version: 1, locales: hashes }, null, 2)}\n`);
    return directory;
  }
  const quietly = (run) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      return run();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  };
  const readHashes = (directory) => JSON.parse(readFileSync(join(directory, "source-hashes.json"), "utf8"));

  it("passes --check for a new key translated without a hash", () => {
    const directory = locales({
      en: { first: "One", added: "New {name}" },
      catalogs: { de: { first: "Eins", added: "Neu {name}" } },
      hashes: { de: { first: sourceHash("One") } },
    });
    expect(() => quietly(() => checkCatalogs(directory))).not.toThrow();
  });

  it("passes --check with hashes left behind by removed keys and languages", () => {
    const directory = locales({
      en: { first: "One" },
      catalogs: { de: { first: "Eins" } },
      hashes: { de: { first: sourceHash("One"), removed: sourceHash("Removed") }, fr: { first: sourceHash("One") } },
    });
    expect(() => quietly(() => checkCatalogs(directory))).not.toThrow();
  });

  it("fails --check when the English source changed since its recorded hash", () => {
    const directory = locales({
      en: { first: "One, reworded" },
      catalogs: { de: { first: "Eins" } },
      hashes: { de: { first: sourceHash("One") } },
    });
    expect(() => quietly(() => checkCatalogs(directory))).toThrow(
      "de.json: first: English source changed; refresh the translation or remove it for English fallback",
    );
  });

  it("--record-hashes fills only missing hashes, keeps stale ones and drops removed keys", () => {
    const staleHash = sourceHash("One");
    const directory = locales({
      en: { first: "One, reworded", second: "Two", added: "New", untranslated: "Later" },
      catalogs: { de: { first: "Eins", second: "Zwei", added: "Neu" }, ja: { second: "二" } },
      hashes: {
        fr: { second: sourceHash("Two") },
        de: { removed: sourceHash("Removed"), first: staleHash, untranslated: sourceHash("Later"), second: sourceHash("Two") },
      },
    });

    quietly(() => recordSourceHashes(directory));

    expect(readHashes(directory)).toEqual({
      version: 1,
      locales: {
        de: { first: staleHash, second: sourceHash("Two"), added: sourceHash("New") },
        ja: { second: sourceHash("Two") },
      },
    });
    expect(Object.keys(readHashes(directory).locales.de)).toEqual(["first", "second", "added"]);
    expect(readFileSync(join(directory, "source-hashes.json"), "utf8")).toBe(
      `${JSON.stringify(readHashes(directory), null, 2)}\n`,
    );
    expect(() => quietly(() => checkCatalogs(directory))).toThrow("de.json: first: English source changed");

    const recorded = readFileSync(join(directory, "source-hashes.json"), "utf8");
    quietly(() => recordSourceHashes(directory));
    expect(readFileSync(join(directory, "source-hashes.json"), "utf8")).toBe(recorded);
  });

  it("--record-hashes refuses to record an invalid catalog", () => {
    const directory = locales({
      en: { first: "Hello {name}" },
      catalogs: { de: { first: "Hallo" } },
      hashes: {},
    });
    expect(() => quietly(() => recordSourceHashes(directory))).toThrow(/placeholders must stay/);
    expect(readHashes(directory)).toEqual({ version: 1, locales: {} });
  });
});

describe("--record-hashes in a git checkout", () => {
  const catalog = (value) => `${JSON.stringify(value, null, 2)}\n`;
  function repository() {
    const directory = temporaryDirectory();
    const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.name", "Locale fixture");
    git("config", "user.email", "locale@example.invalid");
    git("config", "commit.gpgsign", "false");
    const commit = (files, message) => {
      for (const [name, value] of Object.entries(files)) writeFileSync(join(directory, name), catalog(value));
      git("add", "--all");
      git("commit", "--quiet", "-m", message);
    };
    return { directory, git, commit };
  }
  const record = (directory) => {
    const lines = [];
    const error = vi.spyOn(console, "error").mockImplementation((line) => lines.push(line));
    try {
      recordSourceHashes(directory);
    } finally {
      error.mockRestore();
    }
    return lines;
  };
  const check = (directory) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      checkCatalogs(directory);
      return "";
    } catch (error) {
      return error.message;
    } finally {
      log.mockRestore();
    }
  };
  const hashesOf = (directory, code) =>
    JSON.parse(readFileSync(join(directory, "source-hashes.json"), "utf8")).locales[code];

  it("hashes the English a translation was written against, so English changed since then is stale", () => {
    const { directory, commit } = repository();
    commit({
      "en.json": { kept: "Kept", reworded: "Old wording" },
      "de.json": { kept: "Behalten", reworded: "Alter Wortlaut" },
      "source-hashes.json": { version: 1, locales: {} },
    }, "translate both keys");
    commit({ "en.json": { kept: "Kept", reworded: "New wording" } }, "reword the English only");

    const lines = record(directory);

    expect(hashesOf(directory, "de")).toEqual({ kept: sourceHash("Kept"), reworded: sourceHash("Old wording") });
    expect(lines).toContain("de.json: reworded: translated before its English changed; refresh it (pnpm i18n:check fails until then)");
    expect(check(directory)).toBe(
      "de.json: reworded: English source changed; refresh the translation or remove it for English fallback",
    );
  });

  it("follows a value past a commit that only added a comma after it", () => {
    const { directory, commit } = repository();
    commit({
      "en.json": { reworded: "Old wording" },
      "de.json": { reworded: "Alter Wortlaut" },
      "source-hashes.json": { version: 1, locales: {} },
    }, "translate");
    commit({ "en.json": { reworded: "New wording" } }, "reword the English only");
    commit({
      "en.json": { reworded: "New wording", added: "Added" },
      "de.json": { reworded: "Alter Wortlaut", added: "Hinzugefügt" },
    }, "append a key after it");

    record(directory);

    expect(hashesOf(directory, "de")).toEqual({ reworded: sourceHash("Old wording"), added: sourceHash("Added") });
    expect(check(directory)).toContain("de.json: reworded: English source changed");
    expect(check(directory)).not.toContain("added");
  });

  it("falls back to today's English, and says so, when the clone is shallow", () => {
    const { directory: origin, commit } = repository();
    commit({
      "en.json": { reworded: "Old wording" },
      "de.json": { reworded: "Alter Wortlaut" },
      "source-hashes.json": { version: 1, locales: {} },
    }, "translate");
    commit({ "en.json": { reworded: "New wording" } }, "reword the English only");
    const directory = join(temporaryDirectory(), "clone");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", pathToFileURL(origin).href, directory]);

    const lines = record(directory);

    expect(hashesOf(directory, "de")).toEqual({ reworded: sourceHash("New wording") });
    expect(lines).toContain("de.json: hashed today's English for 1 translations because the clone's history is shallow");
  });
});
