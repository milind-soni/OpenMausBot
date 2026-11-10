import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createUpdateChecker, installKind, isNewerVersion, LATEST_RELEASE_URL, STABLE_CHANNEL_URL, updateChannel } from "./update-check.ts";

const release = (tag: string) =>
  ({ ok: true, status: 200, json: async () => ({ tag_name: tag, html_url: `https://github.com/milind-soni/OpenMausBot/releases/tag/${tag}` }) }) as Response;

const promoted = (version: string) =>
  ({ ok: true, status: 200, json: async () => ({ channel: "stable", version, image: `ghcr.io/milind-soni/openmausbot@sha256:${"a".repeat(64)}`, releaseUrl: `https://github.com/milind-soni/OpenMausBot/releases/tag/v${version}` }) }) as Response;
const missing = { ok: false, status: 404, json: async () => ({}) } as Response;
/** GitHub's newest release is `newest`; the stable channel names `stable`, or does not exist yet. */
const github = (newest: string, stable: string | null) => vi.fn(async (url: string | URL | Request) =>
  String(url) === STABLE_CHANNEL_URL ? (stable ? promoted(stable) : missing) : release(newest));

describe("server update check", () => {
  it("tells how this server was installed", () => {
    const none = () => false;
    const root = ["", "srv", "OpenMausBot", "server"].join(sep);
    expect(installKind({ desktopManaged: true, managed: false, serverRoot: root, exists: () => true })).toBe("desktop");
    expect(installKind({ desktopManaged: false, managed: true, serverRoot: root, exists: () => true })).toBe("managed");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/.dockerenv" })).toBe("docker");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/run/.containerenv" })).toBe("podman");
    expect(installKind({
      desktopManaged: false, managed: false, exists: none,
      serverRoot: ["", "usr", "lib", "node_modules", "openmausbot", "dist-server"].join(sep),
    })).toBe("npm");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === join(root, "..", ".git") })).toBe("git");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: none })).toBe("unknown");
  });

  it("compares release versions numerically and never reports a malformed one", () => {
    expect(isNewerVersion("v0.1.93", "0.1.92")).toBe(true);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("v0.2.0", "0.1.99")).toBe(true);
    expect(isNewerVersion("v0.1.92", "0.1.92")).toBe(false);
    expect(isNewerVersion("v0.1.91", "0.1.92")).toBe(false);
    expect(isNewerVersion("nightly", "0.1.92")).toBe(false);
    expect(isNewerVersion("v0.1.93", "unknown")).toBe(false);
    expect(isNewerVersion("v0.1.93", "0.1.93-rc.1")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.2", "0.1.93-rc.1")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.10", "0.1.93-rc.9")).toBe(true);
    expect(isNewerVersion("v0.1.93-rc.1", "0.1.93")).toBe(false);
    expect(isNewerVersion("v0.1.93-rc.1", "0.1.93-rc.1")).toBe(false);
    expect(isNewerVersion("v0.1.93-rc.1.1", "0.1.93-rc.1")).toBe(true);
  });

  it("follows the stable channel, not the newest release, and gives the update command for this install", async () => {
    const fetch = github("v0.1.95", "0.1.93");
    const check = createUpdateChecker({ current: "0.1.92", install: "docker", fetch });
    expect(await check()).toEqual({
      current: "0.1.92",
      install: "docker",
      channel: "stable",
      latest: "0.1.93",
      available: true,
      releaseUrl: "https://github.com/milind-soni/OpenMausBot/releases/tag/v0.1.93",
      command: "git pull && ./update.sh",
      restart: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(STABLE_CHANNEL_URL, expect.anything());
    expect(await createUpdateChecker({ current: "0.1.92", install: "npm", fetch })()).toMatchObject({ latest: "0.1.93", command: "npm install -g openmausbot@0.1.93", restart: true });
  });

  it("offers nothing to a server that is already on the stable version or past it", async () => {
    expect(await createUpdateChecker({ current: "0.1.93", install: "docker", fetch: github("v0.1.95", "0.1.93") })()).toMatchObject({ channel: "stable", latest: "0.1.93", available: false });
    expect(await createUpdateChecker({ current: "0.1.95", install: "docker", fetch: github("v0.1.95", "0.1.93") })()).toMatchObject({ available: false });
  });

  it("goes by the newest release until a first version has been promoted, or when the owner asked for every release", async () => {
    const unpromoted = github("v0.1.93", null);
    expect(await createUpdateChecker({ current: "0.1.92", install: "docker", fetch: unpromoted })()).toMatchObject({
      channel: "newest", latest: "0.1.93", available: true, command: "git pull && ./update.sh --version 0.1.93",
    });
    expect(unpromoted).toHaveBeenLastCalledWith(LATEST_RELEASE_URL, expect.anything());
    const fetch = github("v0.1.95", "0.1.93");
    expect(await createUpdateChecker({ current: "0.1.92", install: "docker", channel: "newest", fetch })()).toMatchObject({ channel: "newest", latest: "0.1.95" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(updateChannel({})).toBe("stable");
    expect(updateChannel({ OMB_UPDATE_CHANNEL: " Newest " })).toBe("newest");
    expect(updateChannel({ OMB_UPDATE_CHANNEL: "latest" })).toBe("stable");
  });

  it("does not take a broken channel record for a version, or fall back past it", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version: "0.1.93-rc.1" }) }) as Response);
    await expect(createUpdateChecker({ current: "0.1.92", install: "docker", fetch })()).rejects.toThrow("The stable channel named no version");
    fetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    await expect(createUpdateChecker({ current: "0.1.92", install: "docker", fetch })()).rejects.toThrow("The stable channel answered 500");
  });

  it("says up to date, and asks at most once an hour", async () => {
    let now = 0;
    const fetch = github("v0.1.92", "0.1.92");
    const check = createUpdateChecker({ current: "0.1.92", install: "npm", fetch, now: () => now });
    expect(await check()).toMatchObject({ available: false, latest: "0.1.92", command: "npm install -g openmausbot@0.1.92", restart: true });
    now = 59 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 61 * 60_000;
    await check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not look anything up for a desktop or hosted server", async () => {
    const fetch = vi.fn();
    for (const install of ["desktop", "managed"] as const) {
      expect(await createUpdateChecker({ current: "0.1.92", install, fetch })()).toEqual({ current: "0.1.92", install, available: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails clearly when GitHub cannot be reached, and tries again next time", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response);
    const check = createUpdateChecker({ current: "0.1.92", install: "git", channel: "newest", fetch });
    await expect(check()).rejects.toThrow("GitHub answered 403");
    fetch.mockImplementation(async () => release("v0.1.93"));
    expect(await check()).toMatchObject({ available: true, command: "git pull && pnpm install", restart: true });
  });
});
