// The mobile mascot sources live inside the projects that compile them.
//
// Nothing in CI builds Android or iOS, so a source file that drifts out of its
// project tree is invisible until somebody opens Xcode or runs Gradle — the
// rebrand once left thirteen of them at the repository root, and neither build
// could have started. This guard pins the two things those builds read: the
// Android module's own source set, and every path ios/project.yml names.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The mascot palette/face sources the Android app module compiles. */
const ANDROID_UI = "android/app/src/main/kotlin/com/astra/companion/ui";
const ANDROID_SOURCES = [
  "AstraAvatar.kt",
  "AstraComets.kt",
  "AstraFaceData.kt",
  "AstraFaceEngine.kt",
  "AstraPalette.kt",
  "AstraSilhouette.kt",
];

/** The Swift copies, by the target that owns them (project.yml mirrors this). */
const IOS_SOURCES = {
  "ios/App": ["AstraAvatar.swift", "AstraFaceData.swift"],
  "ios/AppShared": [
    "AstraSharedConfiguration.swift",
    "AstraSharedConnectionStore.swift",
    "AstraSharedInbox.swift",
    "AstraSharedKeychain.swift",
  ],
  "ios/Widgets": ["AstraWidgets.swift"],
};

/** A copy at the repository root is never compiled by anything. */
const MUST_NOT_BE_AT_ROOT = [...ANDROID_SOURCES, ...Object.values(IOS_SOURCES).flat()];

describe("mobile mascot sources live where their projects read them", () => {
  it("keeps the Android copies in the module's source set, in its own package", () => {
    for (const name of ANDROID_SOURCES) {
      const path = join(root, ANDROID_UI, name);
      expect(existsSync(path), `${ANDROID_UI}/${name} is missing`).toBe(true);
      expect(
        readFileSync(path, "utf8").replace(/^\uFEFF/, ""),
        `${name} must stay in the module's package`,
      ).toMatch(/^package com\.astra\.companion\.ui\b/);
    }
  });

  it("keeps the Swift copies in the targets that declare them", () => {
    for (const [dir, names] of Object.entries(IOS_SOURCES)) {
      for (const name of names) {
        expect(existsSync(join(root, dir, name)), `${dir}/${name} is missing`).toBe(true);
      }
    }
  });

  it("resolves every path ios/project.yml names", () => {
    const spec = readFileSync(join(root, "ios", "project.yml"), "utf8");
    const named = [...new Set([...spec.matchAll(/^\s*- path:\s*(\S+)\s*$/gm)].map((match) => match[1]))];
    expect(named.length).toBeGreaterThan(5);
    for (const path of named) {
      const absolute = isAbsolute(path) ? path : resolve(join(root, "ios"), path);
      expect(existsSync(absolute), `ios/project.yml names a missing path: ${path}`).toBe(true);
    }
  });

  it("leaves no orphaned mascot source at the repository root", () => {
    for (const name of MUST_NOT_BE_AT_ROOT) {
      expect(existsSync(join(root, name)), `${name} sits at the repository root, where nothing compiles it`).toBe(false);
    }
  });
});
