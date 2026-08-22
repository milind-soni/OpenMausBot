import { describe, expect, it } from "vitest";

import {
  hasUnsafeGraphEnvironment,
  isUnsafeGraphEnvironmentName,
  stripUnsafeGraphEnvironment,
  unsafeGraphEnvironmentNames,
  isolatedGraphCapabilityMcpEnvironment,
  isolatedGraphChildEnvironment,
} from "./graph-safe-environment.ts";

describe("graph-safe environment", () => {
  it.each([
    "NODE_OPTIONS",
    "NODE_PATH",
    "OPENSSL_CONF",
    "OPENSSL_MODULES",
    "JDK_JAVA_OPTIONS",
    "node_options",
    "Bash_Env",
    "ENV",
    "ShellOpts",
    "PATH",
    "PathExt",
    "ComSpec",
    "shell",
    "zdotdir",
    "HOME",
    "UserProfile",
    "SystemRoot",
    "windir",
    "tmpdir",
    "TMP",
    "temp",
    "LD_PRELOAD",
    "ld_library_path",
    "DYLD_INSERT_LIBRARIES",
    "dyld_library_path",
    "PythonPath",
    "PYTHONHOME",
    "pythonstartup",
    "rubyopt",
    "Perl5Opt",
    "JAVA_TOOL_OPTIONS",
    "_java_options",
    "gconv_path",
    "omb_claude_api_key_alias",
    "claude_config_dir",
    "anthropic_base_url",
    "openai_api_key",
    "codex_home",
  ])("rejects the process-control name %s case-insensitively", (name) => {
    expect(isUnsafeGraphEnvironmentName(name)).toBe(true);
  });

  it("builds a closed child contract and adds only explicit trusted overrides", () => {
    expect(isolatedGraphChildEnvironment({
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      OPENSSL_CONF: "/tmp/evil.cnf",
      OMB_GRAPH_SAFE_SETTING: "not implicitly trusted",
      HOME: "/tmp/foreign-home",
    }, {
      PATH: "/app/bin",
      CODEX_HOME: "/app/codex-home",
    })).toEqual({
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      PATH: "/app/bin",
      CODEX_HOME: "/app/codex-home",
    });
  });

  it("admits only the exact app-owned capability proxy variables", () => {
    expect(isolatedGraphCapabilityMcpEnvironment({
      ELECTRON_RUN_AS_NODE: "1",
      OMB_HARNESS_URL: "http://127.0.0.1:8799",
      OMB_COMMS_TOKEN: "comms",
      OMB_TURN_TOKEN: "turn",
      NODE_OPTIONS: "--require=/tmp/evil.js",
      EXTRA: "drop",
    })).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      OMB_HARNESS_URL: "http://127.0.0.1:8799",
      OMB_COMMS_TOKEN: "comms",
      OMB_TURN_TOKEN: "turn",
    });
  });

  it("does not overmatch ordinary provider settings", () => {
    for (const name of ["OMB_GRAPH_SAFE_SETTING", "OMP_NUM_THREADS", "MODEL_PATH_HINT", "LDAPI_URL"]) {
      expect(isUnsafeGraphEnvironmentName(name)).toBe(false);
    }
  });

  it("lists and strips every unsafe key without mutating the source", () => {
    const source = {
      ANTHROPIC_BASE_URL: "https://provider.test",
      node_options: "--require=/tmp/evil.js",
      DyLd_InSeRt_LiBrArIeS: "/tmp/evil.dylib",
      OMB_TURN_TOKEN: "opaque",
    };

    expect(hasUnsafeGraphEnvironment(source)).toBe(true);
    expect(unsafeGraphEnvironmentNames(source)).toEqual([
      "ANTHROPIC_BASE_URL",
      "DyLd_InSeRt_LiBrArIeS",
      "node_options",
    ]);
    expect(stripUnsafeGraphEnvironment(source)).toEqual({
      OMB_TURN_TOKEN: "opaque",
    });
    expect(source.node_options).toBe("--require=/tmp/evil.js");
  });
});
