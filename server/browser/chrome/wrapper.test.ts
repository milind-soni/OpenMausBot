import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { batchQuote, browserLanguage, browserTimeZone, languageList, launcherFlags, launcherPath, launcherScript, primaryScreen, writeLauncher, type LauncherSettings } from "./wrapper.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const posix = process.platform !== "win32";
const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

/** What agent-browser 0.37 passes to Chrome (measured), plus arguments a shell would mangle if quoted wrong. */
const ENGINE_ARGS = [
  "--remote-debugging-port=0", "--disable-features=Translate", "--enable-features=NetworkService,NetworkServiceInProcess",
  "--headless=new", "--user-data-dir=/tmp/agent-browser-chrome-0f86c6b4-0a6d-44e3-80a4-0459bb134610", "--window-size=1280,720",
  "--x=it's \"quoted\" $HOME `date` \\n; rm -rf /",
];

describe("the launcher agent-browser runs instead of Chrome", () => {
  const settings: LauncherSettings = { chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", userAgent: UA, screen: { width: 1512, height: 982 }, language: "en-IN" };

  it("adds the identity flags after the engine's own, so they win, keeps the user agent whole, and keeps Chrome off the keychain", () => {
    expect(launcherFlags(settings, "darwin")).toEqual([
      "--disable-blink-features=AutomationControlled", `--user-agent=${UA}`, "--screen-info={1512x982}", "--lang=en-IN", "--use-mock-keychain",
    ]);
    expect(launcherFlags(settings, "linux").at(-1)).toBe("--password-store=basic");
    expect(launcherFlags(settings, "win32").at(-1)).toBe("--lang=en-IN");
    expect(launcherFlags({ ...settings, language: undefined }, "darwin")).not.toContainEqual(expect.stringMatching(/^--lang/u));
  });

  it.skipIf(!posix)("passes every argument through a POSIX shell byte for byte, commas, quotes and dollars included", () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-launcher-"));
    folders.push(folder);
    const chromeFolder = join(folder, "Chrome's \"odd\" $place");
    mkdirSync(chromeFolder);
    const chrome = join(chromeFolder, "Google Chrome");
    writeFileSync(chrome, `#!/bin/sh\nprintf '%s\\0' "$@" > "$ARGV_OUT"\nprintf '%s' "$TZ" > "$ARGV_OUT.tz"\nprintf '%s' "$HOME" > "$ARGV_OUT.home"\n`, { mode: 0o755 });
    const path = launcherPath(join(folder, "data"), "darwin");
    writeLauncher(path, { ...settings, chrome, timeZone: "America/New_York", home: "/Users/ada" }, "darwin");
    expect(statSync(path).mode & 0o777).toBe(0o700);
    const out = join(folder, "argv");
    execFileSync(path, ENGINE_ARGS, { env: { PATH: "/usr/bin:/bin", ARGV_OUT: out, HOME: join(folder, "temporary-home") } });
    const argv = readFileSync(out, "utf8").split("\0").slice(0, -1);
    expect(argv).toEqual([...ENGINE_ARGS, ...launcherFlags(settings, "darwin")]);
    expect(argv).toContain(`--user-agent=${UA}`);
    expect(readFileSync(`${out}.tz`, "utf8")).toBe("America/New_York");
    expect(readFileSync(`${out}.home`, "utf8")).toBe("/Users/ada");
  });

  it("writes a shell script that execs Chrome, so agent-browser keeps Chrome's own pid and process group", () => {
    const script = launcherScript({ ...settings, chrome: "/opt/it's/chrome", timeZone: "Asia/Kolkata" }, "linux");
    expect(script.split("\n")).toEqual([
      "#!/bin/sh",
      "TZ='Asia/Kolkata'",
      "export TZ",
      `exec '/opt/it'\\''s/chrome' "$@" '--disable-blink-features=AutomationControlled' '--user-agent=${UA}' '--screen-info={1512x982}' '--lang=en-IN' '--password-store=basic'`,
      "",
    ]);
  });

  it("writes a Windows batch file that passes the engine's arguments through %* and escapes %", () => {
    const windowsUa = UA.replace("Macintosh; Intel Mac OS X 10_15_7", "Windows NT 10.0; Win64; x64");
    const script = launcherScript({ chrome: "C:\\Users\\Ada 100%\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe", userAgent: windowsUa, screen: { width: 1536, height: 864 }, timeZone: "UTC" }, "win32");
    expect(script).toBe([
      "@echo off",
      `"C:\\Users\\Ada 100%%\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe" %* "--disable-blink-features=AutomationControlled" "--user-agent=${windowsUa}" "--screen-info={1536x864}"`,
      "",
    ].join("\r\n"));
    expect(launcherPath("C:\\data", "win32")).toMatch(/chrome-launcher\.cmd$/u);
    expect(() => batchQuote("--user-agent=\"quoted\"")).toThrow(/quote/);
    expect(() => batchQuote("two\r\nlines")).toThrow(/line break/);
  });
});

describe("the launcher of a Team Cloud's boxed browsers", () => {
  const settings: LauncherSettings = { chrome: "/opt/chrome/chrome", userAgent: UA, screen: { width: 1920, height: 1080 } };

  it.skipIf(!posix)("starts Chrome through bubblewrap with only the profile it was given, the seccomp filter on descriptor 9 and HOME private", () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-boxed-launcher-"));
    folders.push(folder);
    const bwrap = join(folder, "bwrap");
    // A stand-in for bubblewrap: what it was asked, and whether descriptor 9 holds the filter.
    writeFileSync(bwrap, `#!/bin/sh\nprintf '%s\\0' "$@" > "$ARGV_OUT"\ncat <&9 > "$ARGV_OUT.fd9" 2>/dev/null || printf none > "$ARGV_OUT.fd9"\nps -o args= -p $PPID > "$ARGV_OUT.parent"\n`, { mode: 0o755 });
    const filter = join(folder, "seccomp.bpf");
    writeFileSync(filter, "FILTER");
    const path = launcherPath(join(folder, "data"), "linux");
    writeLauncher(path, { ...settings, box: { bwrap, options: ["--unshare-user", "--seccomp", "9", "--ro-bind", "/usr", "/usr"], seccomp: filter } }, "linux");
    const out = join(folder, "argv");
    const profile = join(folder, "profiles", "ada's profile");
    const engine = ["--remote-debugging-port=0", "--headless=new", `--user-data-dir=${profile}`, "--x=it's $HOME"];
    execFileSync(path, engine, { env: { PATH: "/usr/bin:/bin", ARGV_OUT: out } });
    const argv = readFileSync(out, "utf8").split("\0").slice(0, -1);
    expect(argv).toEqual(["--unshare-user", "--seccomp", "9", "--ro-bind", "/usr", "/usr", "--bind", profile, profile, "--setenv", "HOME", "/tmp", "--", "/opt/chrome/chrome", ...engine, ...launcherFlags(settings, "linux")]);
    expect(statSync(profile).isDirectory(), "the profile exists before bubblewrap binds it").toBe(true);
    expect(readFileSync(`${out}.fd9`, "utf8")).toBe("FILTER");
    // bubblewrap's --die-with-parent follows the thread that started it; the launcher, not agent-browser's thread, is its parent.
    expect(readFileSync(`${out}.parent`, "utf8"), "the launcher stays bubblewrap's parent").toContain("chrome-launcher.sh");
    // Without a profile (the launcher's own check), still boxed, binding nothing of the disk.
    execFileSync(path, ["--version"], { env: { PATH: "/usr/bin:/bin", ARGV_OUT: out } });
    const bare = readFileSync(out, "utf8").split("\0").slice(0, -1);
    expect(bare.slice(0, 10)).toEqual(["--unshare-user", "--seccomp", "9", "--ro-bind", "/usr", "/usr", "--setenv", "HOME", "/tmp", "--"]);
    expect(bare).not.toContain("--bind");
  });

  it("is the plain launcher off a team", () => {
    expect(launcherScript(settings, "linux")).not.toContain("bwrap");
    expect(launcherScript(settings, "linux").split("\n").at(-2)).toMatch(/^exec '\/opt\/chrome\/chrome' "\$@" /u);
  });
});

describe("the display, language and time zone the launcher gives Chrome", () => {
  const answer = (output: string) => async () => output;
  const fail = async () => { throw new Error("no display"); };

  it("reads the primary display on each desktop, and declares 1920x1080 where there is none", async () => {
    expect(await primaryScreen("darwin", {}, answer("1512x982\n"))).toEqual({ width: 1512, height: 982 });
    expect(await primaryScreen("win32", {}, answer("1536x864\r\n"))).toEqual({ width: 1536, height: 864 });
    const xrandr = "Screen 0: minimum 8 x 8, current 4480 x 1440\nHDMI-1 connected 2560x1440+1920+0 (normal) 597mm x 336mm\neDP-1 connected primary 1920x1080+0+0 (normal) 344mm x 194mm\n";
    expect(await primaryScreen("linux", { DISPLAY: ":0" }, answer(xrandr))).toEqual({ width: 1920, height: 1080 });
    expect(await primaryScreen("linux", {}, answer(xrandr))).toEqual({ width: 1920, height: 1080 });
    expect(await primaryScreen("darwin", {}, fail)).toEqual({ width: 1920, height: 1080 });
    expect(await primaryScreen("darwin", { OMB_BROWSER_SCREEN: "2560x1440" }, fail)).toEqual({ width: 2560, height: 1440 });
  });

  it("takes the language only when it is known, never guessing over Chrome's own", () => {
    expect(browserLanguage({ OMB_BROWSER_LANG: "de-DE", LANG: "en_US.UTF-8" })).toBe("de-DE");
    expect(browserLanguage({ LANG: "en_GB.UTF-8" })).toBe("en-GB");
    expect(browserLanguage({ LC_ALL: "fr_FR@euro", LANG: "en_US.UTF-8" })).toBe("fr-FR");
    expect(browserLanguage({ LANG: "C.UTF-8" })).toBeUndefined();
    expect(browserLanguage({ LANG: "POSIX" })).toBeUndefined();
    expect(browserLanguage({})).toBeUndefined();
    expect(browserLanguage({ OMB_BROWSER_LANG: "en US; rm" })).toBeUndefined();
  });

  it("gives Chrome the server's time zone, where Chrome reads TZ", () => {
    expect(browserTimeZone({ TZ: "Asia/Kolkata" }, "linux")).toBe("Asia/Kolkata");
    expect(browserTimeZone({ OMB_BROWSER_TIMEZONE: "Europe/Berlin", TZ: "UTC" }, "linux")).toBe("Europe/Berlin");
    expect(browserTimeZone({ TZ: "Asia/Kolkata" }, "win32")).toBeUndefined();
    expect(browserTimeZone({}, "darwin")).toBeUndefined();
    expect(browserTimeZone({ TZ: "Asia/Kolkata'; reboot" }, "linux")).toBeUndefined();
  });
});

describe("the languages pages are told", () => {
  it("lists the person's language, its base and English after, never with q-values", () => {
    expect(languageList("pt-BR")).toBe("pt-BR,pt,en-US,en");
    expect(languageList("en-US")).toBe("en-US,en");
    expect(languageList("en-IN")).toBe("en-IN,en");
    expect(languageList("de")).toBe("de,en-US,en");
    expect(languageList(undefined)).toBe("en-US,en");
  });
});
