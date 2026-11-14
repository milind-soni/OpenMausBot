import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";

import { gateChromeFlags } from "../egress/gate.ts";
import { accountHome, chromeArgs, chromeEnv, fitPage, pageLimit, screenInfo, SERVER_SCREEN } from "./flags.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

describe("Chrome's command line", () => {
  const headless = chromeArgs({ userDataDir: "/data/browser/profiles/abc", mode: "headless", host: "desktop", platform: "darwin", userAgent: UA, screen: { width: 1512, height: 982, deviceScaleFactor: 2, colorDepth: 30 }, locale: "en-GB" });

  it("talks over the pipe and never opens a DevTools port or announces automation", () => {
    expect(headless[0]).toBe("--remote-debugging-pipe");
    expect(headless).toContain("--disable-blink-features=AutomationControlled");
    for (const never of ["--enable-automation", "--no-sandbox", "--hide-scrollbars", "--disable-gpu", "--disable-extensions", "--disable-popup-blocking", "--disable-background-networking", "--disable-renderer-backgrounding"]) {
      expect(headless).not.toContain(never);
    }
    expect(headless.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
  });

  it("keeps the whole user agent, commas included, as one argument", () => {
    expect(headless).toContain(`--user-agent=${UA}`);
    expect(() => chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", userAgent: "x\ny" })).toThrow(/line break/);
  });

  it("gives headless the real display in device pixels, and a window nothing headless-only", () => {
    expect(headless).toContain("--screen-info={3024x1964 devicePixelRatio=2 colorDepth=30}");
    expect(headless).toContain("--headless=new");
    expect(headless).toContain("--mute-audio");
    expect(headless.filter((arg) => arg.startsWith("--disable-features="))).toEqual(["--disable-features=WebUIOmniboxPopup,WebUIOmniboxAimPopup,WebUIReloadButton"]);
    const window = chromeArgs({ userDataDir: "/p", mode: "window", host: "desktop", platform: "darwin", userAgent: UA });
    expect(window.some((arg) => /^--(headless|user-agent|screen-info|mute-audio|disable-features)/.test(arg))).toBe(false);
    expect(window).toContain("--window-size=1280,863");
  });

  it("declares a 1920x1080 screen on servers and keeps containers off /dev/shm", () => {
    const server = chromeArgs({ userDataDir: "/p", mode: "headless", host: "container", platform: "linux" });
    expect(server).toContain(`--screen-info=${screenInfo(SERVER_SCREEN)}`);
    expect(screenInfo(SERVER_SCREEN)).toBe("{1920x1080 devicePixelRatio=1}");
    expect(server).toEqual(expect.arrayContaining(["--disable-dev-shm-usage", "--disk-cache-size=52428800", "--password-store=basic"]));
    expect(server).not.toContain("--use-mock-keychain");
  });

  it("goes only through OMB's own local gate, with the gate's own flags and WebRTC kept on it", () => {
    const gated = chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", platform: "darwin", egressPort: 41234 });
    expect(gated).toEqual(expect.arrayContaining(gateChromeFlags(41234, "darwin")));
    expect(gated).toEqual(expect.arrayContaining(["--proxy-server=socks5://127.0.0.1:41234", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]));
    expect(gated.filter((arg) => arg === "--use-mock-keychain")).toHaveLength(1);
    expect(() => chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", egressPort: 0 })).toThrow(/local gate/);
    expect(() => chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", egressPort: 1.5 })).toThrow(/local gate/);
  });

  it("opens the window at the page size asked for", () => {
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", viewport: { width: 1280, height: 800 } })).toContain("--window-size=1280,943");
  });

  it("keeps a headless window within its screen, and a page that must shrink keeps its shape", () => {
    expect(pageLimit({ width: 1512, height: 982, deviceScaleFactor: 2 }, "darwin")).toEqual({ width: 1512, height: 839 });
    expect(pageLimit(SERVER_SCREEN, "linux")).toEqual({ width: 1920, height: 937 });
    expect(pageLimit(SERVER_SCREEN, "win32")).toEqual({ width: 1904, height: 929 });
    expect(fitPage({ width: 1280, height: 800 }, { width: 1512, height: 839 })).toEqual({ width: 1280, height: 800 });
    expect(fitPage({ width: 1600, height: 1000 }, { width: 1512, height: 839 })).toEqual({ width: 1342, height: 839 });
    expect(fitPage({ width: 1280, height: 800 }, { width: 1440, height: 757 })).toEqual({ width: 1211, height: 757 });
    expect(fitPage({ width: 3000, height: 800 }, { width: 1512, height: 839 })).toEqual({ width: 1512, height: 403 });
    expect(fitPage({ width: 1600, height: 1000 }, null)).toEqual({ width: 1600, height: 1000 });
  });

  it("turns the sandbox off only on an explicit opt-out, and reopens restored tabs without a start page", () => {
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "container", sandbox: false })).toContain("--no-sandbox");
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop" }).at(-1)).toBe("about:blank");
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", startUrl: null }).at(-1)).not.toBe("about:blank");
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", locale: "en-GB; rm -rf" })).not.toContain("--lang=en-GB; rm -rf");
  });

  it("sets the time zone on servers only, and marks the process for the sweep", () => {
    expect(chromeEnv({ PATH: "/bin" }, { host: "server", timezone: "Asia/Kolkata", profileMarker: "abc" })).toMatchObject({ PATH: "/bin", TZ: "Asia/Kolkata", OMB_BROWSER_PROFILE: "abc" });
    expect(chromeEnv({}, { host: "desktop", timezone: "Asia/Kolkata" }).TZ).toBeUndefined();
  });

  it("gives Chrome the account's real home, never the temporary HOME of the process that launches it", () => {
    const home = userInfo().homedir;
    expect(process.env.HOME).not.toBe(home);
    expect(accountHome()).toBe(home);
    expect(chromeEnv({ ...process.env }, { host: "desktop" }).HOME).toBe(home);
    expect(chromeEnv({ HOME: "/tmp/fake-home" }, { host: "server" }).HOME).toBe(home);
    expect(chromeEnv({ HOME: "/data" }, { host: "server" }, "/data").HOME).toBe("/data");
  });

  it("keeps macOS Chrome on the mock keychain, headless or in a window", () => {
    for (const mode of ["headless", "window"] as const) {
      expect(chromeArgs({ userDataDir: "/p", mode, host: "desktop", platform: "darwin" })).toContain("--use-mock-keychain");
      expect(chromeArgs({ userDataDir: "/p", mode, host: "desktop", platform: "linux" })).not.toContain("--use-mock-keychain");
    }
  });
});
