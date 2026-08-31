import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkCatalogs,
  main,
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

  it("detects missing acceptance records and English copy changes", () => {
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
    expect(validateTranslationHashes(source, translation, {})).toEqual([
      "first: translation has not been accepted against its English source",
    ]);
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
