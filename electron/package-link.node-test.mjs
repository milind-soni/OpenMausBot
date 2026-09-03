import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

import {
  enableGrokBotLinkHandler,
  grokBotLinkHandlerStatus,
  grokBotProtocolClientContract,
  packageUrlFromCommandLine,
  packageUrlFromDeepLink,
} from "./package-link.mjs";

const grokShareId = "Abcdefghijklmnopqrstu";
const grokLink = `grokbot://app/v1/bot-template?id=${grokShareId}`;

describe("BotMRR package deep links", () => {
  it("accepts a public GitHub package URL", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromCommandLine(["OpenMausBot", "--flag", `openmausbot://install?url=${encodeURIComponent(target)}`]), target);
  });

  it("routes the exact Grok Bot link from initial argv and second-instance argv", () => {
    assert.equal(packageUrlFromDeepLink(grokLink), grokLink);
    assert.equal(packageUrlFromCommandLine(["OpenMausBot.exe", grokLink]), grokLink, "initial argv");
    assert.equal(packageUrlFromCommandLine(["OpenMausBot.exe", "--second-instance", grokLink]), grokLink, "second-instance argv");

    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    assert.match(main, /pendingPackageInstallUrl\s*=\s*packageUrlFromCommandLine\(process\.argv\)/);
    assert.match(main, /app\.on\("second-instance",[\s\S]*?packageUrlFromCommandLine\(commandLine\)/);
    assert.match(main, /app\.on\("open-url",[\s\S]*?queuePackageInstall\(url\)/);
    assert.match(main, /webContents\.send\("package:install", pendingPackageInstallUrl\)/);

    const sidebar = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
    assert.match(sidebar, /onPackageInstall\?\.\(\(url\)\s*=>\s*\{\s*setTeamInstallUrl\(url\);\s*setTeamLibraryOpen\(true\)/);
    assert.match(sidebar, /<TeamLibraryPanel[\s\S]*?initialUrl=\{teamInstallUrl \?\? undefined\}/);
  });

  it("rejects Grok Bot credentials, fragments, duplicate or extra query, and non-exact routes", () => {
    for (const value of [
      `grokbot://user@app/v1/bot-template?id=${grokShareId}`,
      `grokbot://app/v1/bot-template?id=${grokShareId}#fragment`,
      `grokbot://app/v1/bot-template?id=${grokShareId}#`,
      `grokbot://app/v1/bot-template?id=${grokShareId}&extra=1`,
      `grokbot://app/v1/bot-template?id=${grokShareId}&id=${grokShareId}`,
      `grokbot://app/v1/bot-template/?id=${grokShareId}`,
      `grokbot://app:99/v1/bot-template?id=${grokShareId}`,
      `grokbot://app/v1/bot-template?id=${grokShareId.slice(1)}`,
      `grokbot://app/v1/bot-template?id=${grokShareId}%20`,
      ` grokbot://app/v1/bot-template?id=${grokShareId}`,
    ]) assert.equal(packageUrlFromDeepLink(value), null, value);
  });

  it("accepts only the exact accounts share-package host, path, and opaque id", () => {
    const target = "https://accounts.openmausbot.com/v1/bot-shares/Abcdefghijklmnopqrstu/package";
    expectPackage(target, target);
    expectPackage(`${target}?download=1`, null);
    expectPackage("https://accounts.openmausbot.com/v1/bot-shares/short/package", null);
    expectPackage("https://accounts.openmausbot.com.evil.example/v1/bot-shares/Abcdefghijklmnopqrstu/package", null);
    expectPackage("https://accounts.openmausbot.com/v1/bot-shares/Abcdefghijklmnopqrstu/package.md", null);
  });

  it("rejects other commands, hosts, protocols, credentials, and unsupported file types", () => {
    assert.equal(packageUrlFromDeepLink("openmausbot://settings"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://evil.example/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=http://raw.githubusercontent.com/a/b/main/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://user@example.com/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://github.com/acme/bot/run.sh"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://github.com/acme/bot/bot.json&extra=1"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://user@install?url=https://github.com/acme/bot/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://github.com/acme/bot/bot.json#fragment"), null);
    expectPackage("https://github.com/acme/bot/bot.json?raw=1", null);
    expectPackage("https://github.com/acme/bot/bot.json#fragment", null);
  });

  it("keeps grokbot opt-in and exposes input-free status/enable behavior", () => {
    let currentDefault = false;
    const calls = [];
    const executablePath = "D:\\Codex\\OpenMausBot-custom\\release-local\\win-unpacked\\OpenMausBot.exe";
    const api = {
      platform: "win32",
      packaged: true,
      executablePath,
      isDefaultProtocolClient: (scheme, executable, args) =>
        scheme === "grokbot" && executable === executablePath && args.length === 0 && currentDefault,
      setAsDefaultProtocolClient: (scheme, executable, args) => {
        calls.push([scheme, executable, args]);
        currentDefault = scheme === "grokbot" && executable === executablePath && args.length === 0;
        return currentDefault;
      },
    };
    assert.deepEqual(grokBotLinkHandlerStatus(api), { supported: true, isDefault: false });
    assert.equal(calls.length, 0, "status must not register or capture the protocol");
    assert.deepEqual(enableGrokBotLinkHandler(api), {
      supported: true,
      isDefault: true,
      registrationSucceeded: true,
    });
    assert.deepEqual(calls, [["grokbot", executablePath, []]]);

    const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
    assert.match(preload, /status:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("desktop:grok-link-handler:status"\)/);
    assert.match(preload, /enable:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("desktop:grok-link-handler:enable"\)/);
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(main, /if \(app\.isPackaged\) app\.setAsDefaultProtocolClient\("grokbot"\)/);
    assert.match(main, /executablePath:\s*process\.execPath/);
    assert.match(main, /setAsDefaultProtocolClient:\s*\(\.\.\.args\)\s*=>\s*app\.setAsDefaultProtocolClient\(\.\.\.args\)/);
  });

  it("uses the same exact Windows executable/arguments contract for unpacked and installed releases", () => {
    for (const executablePath of [
      "D:\\Codex\\OpenMausBot-custom\\release-local\\win-unpacked\\OpenMausBot.exe",
      "C:\\Users\\tester\\AppData\\Local\\Programs\\OpenMausBot\\OpenMausBot.exe",
    ]) {
      assert.deepEqual(
        grokBotProtocolClientContract({ platform: "win32", packaged: true, executablePath }),
        { protocol: "grokbot", executablePath, arguments: [] },
      );
    }
    for (const input of [
      { platform: "linux", packaged: true, executablePath: "/opt/OpenMausBot" },
      { platform: "darwin", packaged: true, executablePath: "/Applications/OpenMausBot.app" },
      { platform: "win32", packaged: false, executablePath: "D:\\repo\\node_modules\\electron\\electron.exe" },
      { platform: "win32", packaged: true, executablePath: "OpenMausBot.exe" },
      { platform: "win32", packaged: true, executablePath: "D:\\release\\OpenMausBot.cmd" },
    ]) assert.equal(grokBotProtocolClientContract(input), null);
  });

  it("delivers an early preload link once across renderer subscription timing and remount", () => {
    const { bridge, emit } = loadPreloadBridge();
    emit("package:install", grokLink);
    const deliveries = [];
    const unsubscribe = bridge.onPackageInstall((url) => deliveries.push(url));
    unsubscribe();
    bridge.onPackageInstall((url) => deliveries.push(url));
    assert.deepEqual(deliveries, [grokLink]);
  });

  it("delivers a live preload link once without replaying it to a later subscriber", () => {
    const { bridge, emit } = loadPreloadBridge();
    const first = [];
    const second = [];
    const unsubscribe = bridge.onPackageInstall((url) => first.push(url));
    emit("package:install", grokLink);
    unsubscribe();
    bridge.onPackageInstall((url) => second.push(url));
    assert.deepEqual(first, [grokLink]);
    assert.deepEqual(second, []);
  });

  it("keeps builder metadata free of an automatic grokbot association", () => {
    const metadata = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    assert.match(metadata, /name: OpenMausBot package install\s+schemes: \[openmausbot\]/);
    assert.doesNotMatch(metadata, /schemes:\s*\[[^\]]*grokbot/i);
  });
});

function expectPackage(target, expected) {
  assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(target)}`), expected);
}

function loadPreloadBridge() {
  const listeners = new Map();
  let bridge;
  const ipcRenderer = {
    on(channel, listener) {
      const channelListeners = listeners.get(channel) ?? [];
      channelListeners.push(listener);
      listeners.set(channel, channelListeners);
    },
    removeListener() {},
    invoke() {},
    send() {},
    sendSync() {},
  };
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "win32", argv: [] },
    require(id) {
      if (id !== "electron") throw new Error(`Unexpected preload dependency: ${id}`);
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, "ogb");
            bridge = value;
          },
        },
        ipcRenderer,
        webUtils: { getPathForFile: () => "" },
      };
    },
  });
  assert.ok(bridge);
  return {
    bridge,
    emit(channel, value) {
      for (const listener of listeners.get(channel) ?? []) listener({}, value);
    },
  };
}
