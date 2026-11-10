import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkIndex, checkRelease, SOAK_MS, stableRecord, stableVersion } from "../stable-channel.mjs";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const release = (patch: Record<string, unknown> = {}) => ({
  tagName: "v0.1.151", isDraft: false, isPrerelease: false, publishedAt: "2026-11-09T22:56:49Z",
  url: "https://github.com/milind-soni/OpenMausBot/releases/tag/v0.1.151", ...patch,
});
const pinned = (name: string, letter: string) => `ghcr.io/milind-soni/${name}@sha256:${letter.repeat(64)}`;
const IMAGE = pinned("openmausbot", "a");
const HOME = pinned("openmausbot-cloud-home", "b");
const index = (...platforms: string[]) => ({
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [...platforms, "unknown/unknown"].map((platform) => ({ platform: { os: platform.split("/")[0], architecture: platform.split("/")[1] } })),
});

describe("the stable channel", () => {
  it("takes a released version number and nothing else", () => {
    expect(stableVersion("v0.1.151")).toBe("0.1.151");
    expect(stableVersion(" 0.1.151 ")).toBe("0.1.151");
    for (const bad of ["latest", "0.1", "0.1.151-rc.1", "main", "", "sha-abc"]) expect(() => stableVersion(bad), bad).toThrow("is not a released version");
  });

  it("refuses a version that is not a published release, or has not had its 48 hours", () => {
    expect(() => checkRelease(release(), "0.1.151", { now: NOW })).not.toThrow();
    expect(() => checkRelease(null, "0.1.151", { now: NOW })).toThrow("v0.1.151 is not a release of this repository");
    expect(() => checkRelease(release({ tagName: "v0.1.150" }), "0.1.151", { now: NOW })).toThrow("is not a release");
    expect(() => checkRelease(release({ isDraft: true }), "0.1.151", { now: NOW })).toThrow("still a draft");
    expect(() => checkRelease(release({ isPrerelease: true }), "0.1.151", { now: NOW })).toThrow("prerelease");
    const fresh = Date.parse(release().publishedAt) + SOAK_MS - 60_000;
    expect(() => checkRelease(release(), "0.1.151", { now: fresh })).toThrow("was published 47 hours ago");
    expect(() => checkRelease(release(), "0.1.151", { now: fresh, urgent: true })).not.toThrow();
  });

  it("refuses an image that lacks one of the platforms", () => {
    expect(() => checkIndex(index("linux/amd64", "linux/arm64"), ["linux/amd64", "linux/arm64"], "the server image")).not.toThrow();
    expect(() => checkIndex(index("linux/amd64"), ["linux/amd64", "linux/arm64"], "the server image")).toThrow("the server image has no image for linux/arm64");
    expect(() => checkIndex({ mediaType: "application/vnd.oci.image.manifest.v1+json" }, ["linux/amd64"], "the server image")).toThrow("not a multi-platform image");
  });

  it("records the version with both images by digest, and update.sh reads it from the top level, whatever the history holds", () => {
    const record = stableRecord({ version: "0.1.151", image: IMAGE, cloudHomeImage: HOME, release: release(), current: null, now: NOW });
    expect(record).toEqual({
      channel: "stable", version: "0.1.151", image: IMAGE, cloudHomeImage: HOME, platforms: ["linux/amd64", "linux/arm64"],
      releaseUrl: release().url, releasedAt: release().publishedAt, promotedAt: "2026-11-12T12:00:00.000Z",
      history: [{ version: "0.1.151", promotedAt: "2026-11-12T12:00:00.000Z" }],
    });
    expect(() => stableRecord({ version: "0.1.151", image: "ghcr.io/milind-soni/openmausbot:v0.1.151", cloudHomeImage: HOME, release: release(), current: null, now: NOW })).toThrow("is not pinned by digest");
    if (process.platform === "win32") return;
    // Three promotions: the history then names older versions after the current one, as it does from the second on.
    let next = record;
    for (const [version, days] of [["0.1.152", 7], ["0.1.153", 14]] as const) {
      next = stableRecord({ version, image: IMAGE, cloudHomeImage: HOME, release: release(), current: next, now: NOW + days * 86_400_000 });
    }
    expect(next.history.map((entry) => entry.version)).toEqual(["0.1.153", "0.1.152", "0.1.151"]);
    // deploy/update.sh's own reader, run on the record as the workflow writes it.
    const script = readFileSync(join(import.meta.dirname, "..", "..", "deploy", "update.sh"), "utf8");
    const reader = /^json_top\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0];
    expect(reader).toBeDefined();
    const read = (key: string) => spawnSync("bash", ["-c", `${reader}\njson_top "$1"`, "json_top", key], { input: JSON.stringify(next, null, 2), encoding: "utf8" });
    expect(read("version").stdout.trim()).toBe("0.1.153");
    expect(read("image").stdout.trim()).toBe(IMAGE);
    expect(read("promotedAt").stdout.trim()).toBe(next.promotedAt);
  });

  it("will not move stable back unless told to, and promoting the same version again keeps its date", () => {
    const first = stableRecord({ version: "0.1.151", image: IMAGE, cloudHomeImage: HOME, release: release(), current: null, now: NOW });
    expect(() => stableRecord({ version: "0.1.150", image: IMAGE, cloudHomeImage: HOME, release: release(), current: first, now: NOW })).toThrow("stable is 0.1.151, which is newer than 0.1.150");
    expect(stableRecord({ version: "0.1.150", image: IMAGE, cloudHomeImage: HOME, release: release(), current: first, now: NOW + 1000, allowOlder: true }).history.map((entry) => entry.version)).toEqual(["0.1.150", "0.1.151"]);
    expect(stableRecord({ version: "0.1.151", image: IMAGE, cloudHomeImage: HOME, release: release(), current: first, now: NOW + 86_400_000 })).toEqual(first);
  });

  it("keeps every version that was stable in the last 90 days, which is what an app needs to judge a server's age", () => {
    const day = 86_400_000;
    let record = null;
    for (const [version, daysAgo] of [["0.1.100", 200], ["0.1.110", 120], ["0.1.120", 60], ["0.1.130", 10]] as const) {
      record = stableRecord({ version, image: IMAGE, cloudHomeImage: HOME, release: release(), current: record, now: NOW - daysAgo * day });
    }
    record = stableRecord({ version: "0.1.151", image: IMAGE, cloudHomeImage: HOME, release: release(), current: record, now: NOW });
    // 0.1.110 was still the stable one 90 days ago; 0.1.100 was replaced before that.
    expect(record.history.map((entry) => entry.version)).toEqual(["0.1.151", "0.1.130", "0.1.120", "0.1.110"]);
  });
});
