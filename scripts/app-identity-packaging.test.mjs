import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  APP_ID,
  BROWSER_APPARMOR_PROFILE,
  DEEP_LINK_SCHEME,
  DESKTOP_ENTRY_NAME,
  LINUX_EXECUTABLE_NAME,
  LINUX_INSTALL_DIR,
  PHONE_DISCOVERY_SERVICE_TYPE,
  PRODUCT_NAME,
} from "../electron/app-identity.mjs";

// Git on the Windows runners checks text files out with CRLF line endings.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const builder = parse(read("electron-builder.yml"));
const pkg = JSON.parse(read("package.json"));

describe("packaging agrees with electron/app-identity.mjs", () => {
  it("names the app, its id and its desktop entry the same way", () => {
    expect(builder.appId).toBe(APP_ID);
    expect(builder.productName).toBe(PRODUCT_NAME);
    expect(pkg.productName).toBe(PRODUCT_NAME);
    expect(pkg.desktopName).toBe(DESKTOP_ENTRY_NAME);
    expect(builder.nsis.shortcutName).toBe(PRODUCT_NAME);
    expect(builder.linux.desktop.entry.Name).toBe(PRODUCT_NAME);
  });

  it("registers only the app's own link scheme", () => {
    expect(builder.protocols.flatMap((protocol) => protocol.schemes)).toEqual([DEEP_LINK_SCHEME]);
  });

  it("lists the Bonjour service type the phone apps browse for", () => {
    expect(builder.mac.extendInfo.NSBonjourServices).toEqual([PHONE_DISCOVERY_SERVICE_TYPE]);
  });

  it("installs Linux packages in a folder without spaces", () => {
    const linuxBuilds = Object.values(pkg.scripts).filter((script) => script.includes("electron-builder --linux"));
    expect(linuxBuilds).toHaveLength(4);
    for (const script of linuxBuilds) expect(script).toContain(`electron-builder --linux -c.productName=${LINUX_EXECUTABLE_NAME} `);
    expect(LINUX_INSTALL_DIR).toBe(`/opt/${LINUX_EXECUTABLE_NAME}`);
    expect(LINUX_INSTALL_DIR).not.toMatch(/\s/);
  });

  it("installs the Linux executable, folder and browser profile where the package hooks look", () => {
    expect(builder.linux.executableName).toBe(LINUX_EXECUTABLE_NAME);
    expect(builder.rpm.fpm).toContain(LINUX_INSTALL_DIR);
    expect(builder.linux.extraResources).toContainEqual({ from: `build/linux-${BROWSER_APPARMOR_PROFILE}.apparmor`, to: `${BROWSER_APPARMOR_PROFILE}.apparmor` });
    expect(read(`build/linux-${BROWSER_APPARMOR_PROFILE}.apparmor`)).toMatch(new RegExp(`^profile ${BROWSER_APPARMOR_PROFILE} "${LINUX_INSTALL_DIR}/`, "m"));
    expect(read("build/linux-after-install.sh")).toContain(`APP_ROOT='${LINUX_INSTALL_DIR}'`);
    expect(read("build/linux-after-install.sh")).toContain(`/${BROWSER_APPARMOR_PROFILE}.apparmor`);
    const afterRemove = read("build/linux-after-remove.sh");
    expect(afterRemove).toContain(`update-alternatives --remove ${LINUX_EXECUTABLE_NAME} '${LINUX_INSTALL_DIR}/${LINUX_EXECUTABLE_NAME}'`);
    expect(afterRemove).toContain(`profile=$APPARMOR_DIR/${BROWSER_APPARMOR_PROFILE}\n`);
  });
});
