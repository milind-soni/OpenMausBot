import { describe, expect, it } from "vitest";

import { buildMcpChildEnv } from "./mcp-gate-env.ts";

describe("buildMcpChildEnv", () => {
  it("filters parentEnv down to allowlisted variables, dropping sentinels and secrets", () => {
    const parentEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      USER: "user",
      LOGNAME: "user",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
      TMPDIR: "/tmp",
      TERM: "xterm-256color",
      HTTP_PROXY: "http://proxy:8080",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/cert.pem",
      // Sentinels that MUST be dropped:
      OPENAI_API_KEY: "SENTINEL_OPENAI_KEY",
      ANTHROPIC_API_KEY: "SENTINEL_ANTHROPIC_KEY",
      OMB_COMMS_TOKEN: "SENTINEL_COMMS_TOKEN",
      GITHUB_TOKEN: "SENTINEL_GITHUB_TOKEN",
      AWS_SECRET_ACCESS_KEY: "SENTINEL_AWS_SECRET",
      NODE_OPTIONS: "--max-old-space-size=4096",
      OMB_GATE_PRIVATE_CONFIG: "secret",
      DATABASE_PASSWORD: "supersecretpassword",
    };

    const env = buildMcpChildEnv(parentEnv, undefined, undefined, "linux");

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.USER).toBe("user");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.HTTP_PROXY).toBe("http://proxy:8080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/cert.pem");

    // Dropped sentinels
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OMB_COMMS_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OMB_GATE_PRIVATE_CONFIG).toBeUndefined();
    expect(env.DATABASE_PASSWORD).toBeUndefined();
  });

  it("applies spec.env and strips any OMB_GATE_* variables even from spec.env", () => {
    const parentEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
    };
    const specEnv = {
      PATH: "/custom/path",
      CUSTOM_SETTING: "value",
      OMB_GATE_INJECT: "evil",
    };

    const env = buildMcpChildEnv(parentEnv, specEnv, undefined, "linux");
    expect(env.PATH).toBe("/custom/path");
    expect(env.CUSTOM_SETTING).toBe("value");
    expect(env.OMB_GATE_INJECT).toBeUndefined();
  });

  it("allows declared passthrough names and ignores invalid or undeclared names", () => {
    const parentEnv = {
      PATH: "/bin",
      ALLOWED_CUSTOM_VAR: "allowed_value",
      FORBIDDEN_VAR: "secret_value",
      "INVALID-NAME!": "invalid",
    };

    const env = buildMcpChildEnv(
      parentEnv,
      undefined,
      ["ALLOWED_CUSTOM_VAR", "UNDEFINED_VAR", "INVALID-NAME!"],
      "linux",
    );

    expect(env.ALLOWED_CUSTOM_VAR).toBe("allowed_value");
    expect(env.FORBIDDEN_VAR).toBeUndefined();
    expect(env["INVALID-NAME!"]).toBeUndefined();
    expect(env.UNDEFINED_VAR).toBeUndefined();
  });

  it("handles win32 case-insensitive matching for Windows environment variables", () => {
    const parentEnv = {
      path: "C:\\Windows\\System32;C:\\Program Files",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      userprofile: "C:\\Users\\User",
      appdata: "C:\\Users\\User\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\User\\AppData\\Local",
      comspec: "C:\\Windows\\System32\\cmd.exe",
      pathext: ".COM;.EXE;.BAT;.CMD",
      OPENAI_API_KEY: "sentinel_secret",
    };

    const env = buildMcpChildEnv(parentEnv, undefined, undefined, "win32");
    expect(env.path || env.PATH).toBe("C:\\Windows\\System32;C:\\Program Files");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.windir).toBe("C:\\Windows");
    expect(env.userprofile).toBe("C:\\Users\\User");
    expect(env.appdata).toBe("C:\\Users\\User\\AppData\\Roaming");
    expect(env.LOCALAPPDATA).toBe("C:\\Users\\User\\AppData\\Local");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
