import { describe, expect, it } from "vitest";
import { launchesThroughWsl, withWslNotice, WSL_ENGINE_WARNING } from "./wsl-launch.ts";

describe("launchesThroughWsl", () => {
  it.each([
    "wsl hermes",
    "wsl.exe -d Ubuntu -- hermes",
    "WSL.EXE hermes",
    "C:\\Windows\\System32\\wsl.exe hermes",
    "\"C:\\Windows\\System32\\wsl.exe\" -e hermes",
    "C:/Windows/System32/wsl.exe hermes",
    "C:\\Windows\\System32\\bash.exe -c hermes",
    "C:\\Windows\\Sysnative\\bash.exe -c hermes",
  ])("counts %s on Windows", (cli) => {
    expect(launchesThroughWsl(cli, "win32")).toBe(true);
  });

  it.each([
    undefined,
    "",
    "hermes",
    "C:\\Users\\me\\AppData\\Local\\hermes\\hermes.exe",
    "\"C:\\Program Files\\Git\\bin\\bash.exe\" -c hermes",
    "bash -c hermes",
    "C:\\tools\\wslhermes.exe",
    "hermes --profile wsl",
  ])("does not count %s on Windows", (cli) => {
    expect(launchesThroughWsl(cli, "win32")).toBe(false);
  });

  it.each(["linux", "darwin"] as const)("never counts anything on %s", (platform) => {
    expect(launchesThroughWsl("wsl hermes", platform)).toBe(false);
    expect(launchesThroughWsl("/usr/bin/wsl", platform)).toBe(false);
  });
});

describe("withWslNotice", () => {
  const wsl = "wsl.exe -d Ubuntu -- hermes";

  it("adds the WSL notice on Windows and keeps the rest of the status", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      expect(withWslNotice({ state: "available", authenticated: true, version: "1.2.3" }, wsl))
        .toEqual({ state: "available", authenticated: true, version: "1.2.3", warning: WSL_ENGINE_WARNING });
      const own = { title: "Check ChatGPT connection", message: "plan" };
      expect(withWslNotice({ state: "available", warning: own }, wsl).warning).toEqual(own);
      expect(withWslNotice({ state: "available" }, "hermes")).toEqual({ state: "available" });
      expect(withWslNotice({ state: "unavailable", reason: "no distro" }, wsl)).not.toHaveProperty("warning");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
