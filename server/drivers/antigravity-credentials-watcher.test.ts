import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GeminiCredentialsWatcher,
  type GlobalOAuthCreds,
  type OmAcpToken,
} from "./antigravity-credentials-watcher.ts";

describe("GeminiCredentialsWatcher", () => {
  let tempDir: string;
  let geminiDir: string;
  let targetTokenDir: string;
  let targetTokenPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omb-creds-watcher-test-"));
    geminiDir = join(tempDir, ".gemini");
    targetTokenDir = join(tempDir, "provider", "antigravity-acp");
    targetTokenPath = join(targetTokenDir, "acp_token.json");
    await mkdir(geminiDir, { recursive: true });
    await mkdir(targetTokenDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("syncs credentials from global oauth_creds.json to target acp_token.json", async () => {
    const globalCreds: GlobalOAuthCreds = {
      access_token: "ya29.initial",
      refresh_token: "1//refresh_token_1",
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
    };
    await writeFile(join(geminiDir, "oauth_creds.json"), JSON.stringify(globalCreds));
    await writeFile(join(geminiDir, "google_accounts.json"), JSON.stringify({ active: "user1@example.com" }));

    const switched = vi.fn();
    const watcher = new GeminiCredentialsWatcher("test-instance", switched, {
      geminiDir,
      targetTokenPath,
      debounceMs: 50,
    });

    const changed = await watcher.syncCredentials();
    expect(changed).toBe(true);

    const tokenContent = JSON.parse(await readFile(targetTokenPath, "utf8")) as OmAcpToken;
    expect(tokenContent.refresh_token).toBe("1//refresh_token_1");
    expect(tokenContent.client_id).toBe("1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
    expect(tokenContent.token_uri).toBe("https://oauth2.googleapis.com/token");
    expect(tokenContent.project_id).toBe("aicode-consumers");
    expect(tokenContent.scopes).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email"]);

    expect(switched).toHaveBeenCalledWith({
      refreshToken: "1//refresh_token_1",
      email: "user1@example.com",
    });
  });

  it("does not rewrite if refresh_token has not changed", async () => {
    const globalCreds: GlobalOAuthCreds = {
      refresh_token: "1//same_token",
    };
    await writeFile(join(geminiDir, "oauth_creds.json"), JSON.stringify(globalCreds));

    const switched = vi.fn();
    const watcher = new GeminiCredentialsWatcher("test-instance", switched, {
      geminiDir,
      targetTokenPath,
    });

    const first = await watcher.syncCredentials();
    expect(first).toBe(true);
    expect(switched).toHaveBeenCalledTimes(1);

    const second = await watcher.syncCredentials();
    expect(second).toBe(false);
    expect(switched).toHaveBeenCalledTimes(1);
  });

  it("preserves existing client_id and client_secret if present in target token file", async () => {
    const existing: Partial<OmAcpToken> = {
      client_id: "custom-client-id",
      client_secret: "custom-secret",
      project_id: "custom-project",
    };
    await writeFile(targetTokenPath, JSON.stringify(existing));

    const globalCreds: GlobalOAuthCreds = {
      refresh_token: "1//new_token",
    };
    await writeFile(join(geminiDir, "oauth_creds.json"), JSON.stringify(globalCreds));

    const watcher = new GeminiCredentialsWatcher("test-instance", undefined, {
      geminiDir,
      targetTokenPath,
    });
    await watcher.syncCredentials();

    const tokenContent = JSON.parse(await readFile(targetTokenPath, "utf8")) as OmAcpToken;
    expect(tokenContent.refresh_token).toBe("1//new_token");
    expect(tokenContent.client_id).toBe("custom-client-id");
    expect(tokenContent.client_secret).toBe("custom-secret");
    expect(tokenContent.project_id).toBe("custom-project");
  });

  it("waitForNewToken resolves true when token changes and false on timeout", async () => {
    const watcher = new GeminiCredentialsWatcher("test-instance", undefined, {
      geminiDir,
      targetTokenPath,
      debounceMs: 20,
    });
    watcher.start();

    // Timeout case
    const timedOut = await watcher.waitForNewToken(100);
    expect(timedOut).toBe(false);

    // Success case
    const waitPromise = watcher.waitForNewToken(1000);
    const globalCreds: GlobalOAuthCreds = {
      refresh_token: "1//switched_token",
    };
    await writeFile(join(geminiDir, "oauth_creds.json"), JSON.stringify(globalCreds));

    const success = await waitPromise;
    expect(success).toBe(true);

    watcher.stop();
  });
});
