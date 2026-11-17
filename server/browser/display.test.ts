import { describe, expect, it } from "vitest";

import { SERVER_SCREEN } from "./chrome/flags.ts";
import { displayScreen, parseDisplay } from "./display.ts";

const answering = (text: string) => async () => text;

describe("the display a headless bot browser reports", () => {
  it("reads a size in CSS pixels and a scale", () => {
    expect(parseDisplay("1512x982@2")).toEqual({ width: 1512, height: 982, deviceScaleFactor: 2 });
    expect(parseDisplay("1920x1080")).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    expect(parseDisplay("2560x1440@1.25")).toEqual({ width: 2560, height: 1440, deviceScaleFactor: 1.25 });
    expect(parseDisplay("1512x982@9")).toBeNull();
    expect(parseDisplay("no display")).toBeNull();
  });

  it("is the Mac's main display with its Retina scale on a desktop", async () => {
    expect(await displayScreen("desktop", { platform: "darwin", env: {}, runCommand: answering("1512x982@2\n") })).toEqual({ width: 1512, height: 982, deviceScaleFactor: 2 });
  });

  it("is Windows' primary screen at the scale the person set", async () => {
    expect(await displayScreen("desktop", { platform: "win32", env: {}, runCommand: answering("1536x864@1.25\r\n") })).toEqual({ width: 1536, height: 864, deviceScaleFactor: 1.25 });
  });

  it("divides an X display's pixels by GDK_SCALE", async () => {
    const xrandr = "Screen 0: minimum 8 x 8, current 3840 x 2160\nDP-1 connected primary 3840x2160+0+0 (normal left inverted right x axis y axis) 600mm x 340mm\n";
    expect(await displayScreen("desktop", { platform: "linux", env: { DISPLAY: ":0", GDK_SCALE: "2" }, runCommand: answering(xrandr) })).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 2 });
  });

  it("takes an X display's scale from Xft.dpi when GDK_SCALE is not set, as Cinnamon, GNOME and KDE set it", async () => {
    const xrandr = "Screen 0: minimum 8 x 8, current 3840 x 2160\nDP-1 connected primary 3840x2160+0+0 (normal left inverted right x axis y axis) 600mm x 340mm\n";
    const desktop = (xrdb: string | Error) => async (file: string) => {
      if (file === "xrandr") return xrandr;
      if (xrdb instanceof Error) throw xrdb;
      return xrdb;
    };
    const linux = (xrdb: string | Error, env: NodeJS.ProcessEnv = { DISPLAY: ":0" }) => displayScreen("desktop", { platform: "linux", env, runCommand: desktop(xrdb) });
    expect(await linux("*customization:\t-color\nXft.dpi:\t192\nXft.antialias:\t1\n")).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 2 });
    expect(await linux("Xft.dpi: 144\n")).toEqual({ width: 2560, height: 1440, deviceScaleFactor: 1.5 });
    expect(await linux("Xft.dpi:\t96\n")).toEqual({ width: 3840, height: 2160, deviceScaleFactor: 1 });
    expect(await linux("*customization:\t-color\n")).toEqual({ width: 3840, height: 2160, deviceScaleFactor: 1 });
    expect(await linux(new Error("no xrdb"))).toEqual({ width: 3840, height: 2160, deviceScaleFactor: 1 });
    expect(await linux("Xft.dpi:\t192\n", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" })).toEqual({ width: 3840, height: 2160, deviceScaleFactor: 1 });
    expect(await linux("Xft.dpi:\t192\n", { DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" })).toEqual({ width: 3840, height: 2160, deviceScaleFactor: 1 });
    expect(await linux("Xft.dpi:\t192\n", { DISPLAY: ":0", GDK_SCALE: "1" })).toEqual({ width: 3840, height: 2160, deviceScaleFactor: 1 });
  });

  it("is a declared 1920x1080 at 1x on a server or in a container, and when the desktop cannot be read", async () => {
    const never = async () => { throw new Error("should not run"); };
    expect(await displayScreen("server", { platform: "linux", env: {}, runCommand: never })).toEqual(SERVER_SCREEN);
    expect(await displayScreen("container", { platform: "linux", env: {}, runCommand: never })).toEqual(SERVER_SCREEN);
    expect(await displayScreen("desktop", { platform: "darwin", env: {}, runCommand: async () => { throw new Error("no osascript"); } })).toEqual(SERVER_SCREEN);
    expect(await displayScreen("desktop", { platform: "linux", env: {}, runCommand: never })).toEqual(SERVER_SCREEN);
  });

  it("takes OMB_BROWSER_SCREEN over anything it would read", async () => {
    const never = async () => { throw new Error("should not run"); };
    expect(await displayScreen("server", { platform: "linux", env: { OMB_BROWSER_SCREEN: "1280x800@2" }, runCommand: never })).toEqual({ width: 1280, height: 800, deviceScaleFactor: 2 });
  });
});
