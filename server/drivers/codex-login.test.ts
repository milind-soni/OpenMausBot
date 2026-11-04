import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { codexLoginCheck } from "./codex-login.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

describe("Codex login check", () => {
  let home: string;
  const env = (mode: string) => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: home, FAKE_CODEX_MODE: mode });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-codex-login-"));
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => { await removeTempDir(home); });

  it("does not let a status asked before forget confirm the login again", async () => {
    const login = codexLoginCheck(FAKE_CLI);
    const asked = login.check(env("api-key-configured"));
    login.forget();
    await expect(asked).resolves.toBe("present");
    await expect(login.check(env("logged-out"))).resolves.toBe("missing");
  });
});
