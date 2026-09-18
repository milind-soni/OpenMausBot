// The native tee is the file people paste into bug reports, so the wiring
// that keeps credentials out of it is tested at the writer — redact.test.ts
// covers the masking function, this covers that appendNative actually calls it.
// (server/testing/setup.ts points HOME at a throwaway dir, so NATIVE_DIR is
// already isolated from the real fleet.)
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { appendNative } from "./native.ts";

beforeAll(() => ensureDirs());

describe("appendNative", () => {
  it("masks the tokens an ACP session/new hands the agent", () => {
    appendNative("t-native", {
      dir: "out",
      source: "acp",
      msg: {
        method: "session/new",
        params: {
          mcpServers: [
            {
              name: "computer",
              env: [
                { name: "OGB_BOX_ID", value: "box-7" },
                { name: "OGB_BOX_TOKEN", value: "box_live_dontlogme" },
              ],
            },
          ],
        },
      },
    });

    const log = readFileSync(join(NATIVE_DIR, "t-native.ndjson"), "utf8");
    expect(log).not.toContain("box_live_dontlogme");
    // The protocol method remains available, but integration configuration is
    // intentionally absent from native diagnostics.
    expect(log).toContain("session/new");
    expect(log).toContain("[MCP configuration omitted]");
  });

  it("writes the log private to the user", () => {
    appendNative("t-mode", { dir: "in", source: "acp", msg: { hello: "world" } });
    const mode = statSync(join(NATIVE_DIR, "t-mode.ndjson")).mode & 0o777;
    // Windows does not implement POSIX modes; everywhere else, owner-only
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("omits native prompts, session cursors, paths, and MCP configuration", () => {
    appendNative("t-private", {
      dir: "out",
      source: "test.acp",
      msg: {
        method: "session/prompt",
        params: {
          sessionId: "native-session-secret",
          cwd: "/private/project",
          mcpServers: [{ name: "agents", command: "/private/proxy", env: [{ name: "OMB_COMMS_TOKEN", value: "credential" }] }],
          prompt: [{ type: "text", text: "PRIVATE_PROMPT_BODY" }],
        },
      },
    });
    const log = readFileSync(join(NATIVE_DIR, "t-private.ndjson"), "utf8");
    expect(log).not.toContain("native-session-secret");
    expect(log).not.toContain("/private/project");
    expect(log).not.toContain("PRIVATE_PROMPT_BODY");
    expect(log).not.toContain("OMB_COMMS_TOKEN");
    expect(log).toContain('"bytes":19');
    expect(log).toContain("[MCP configuration omitted]");
  });

  it("omits provider thread and prompt-run identifiers from diagnostics", () => {
    appendNative("t-provider-ids", {
      dir: "out",
      source: "codex.app-server",
      msg: {
        method: "turn/start",
        params: {
          threadId: "codex-thread-secret",
          promptId: "box-prompt-secret",
          promptRun: { id: "box-run-secret", status: "started" },
        },
      },
    });
    const log = readFileSync(join(NATIVE_DIR, "t-provider-ids.ndjson"), "utf8");
    expect(log).not.toMatch(/codex-thread-secret|box-prompt-secret|box-run-secret/);
    expect(log).toContain("[native session id omitted]");
    expect(log).toContain("[native run id omitted]");
  });

  it("never throws, whatever it is handed", () => {
    expect(() => appendNative("t-bad", { dir: "in", source: "acp", msg: undefined })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => appendNative("t-cyclic", { dir: "in", source: "acp", msg: cyclic })).not.toThrow();
  });
});
