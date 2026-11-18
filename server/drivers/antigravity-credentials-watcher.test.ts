import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GeminiCredentialsWatcher,
  REQUIRED_ACP_SCOPE,
  resolveAcpScopes,
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
    expect(tokenContent.scopes).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      REQUIRED_ACP_SCOPE,
    ]);

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

  it("preserves existing client_id, client_secret, and aicode scope after verifying refresh token", async () => {
    const existing: Partial<OmAcpToken> = {
      client_id: "custom-client-id",
      client_secret: "custom-secret",
      project_id: "custom-project",
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        REQUIRED_ACP_SCOPE,
      ],
    };
    await writeFile(targetTokenPath, JSON.stringify(existing));

    const globalCreds: GlobalOAuthCreds = {
      refresh_token: "1//new_token",
      scope: "https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform",
    };
    await writeFile(join(geminiDir, "oauth_creds.json"), JSON.stringify(globalCreds));

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("client_id")).toBe("custom-client-id");
      expect(body.get("client_secret")).toBe("custom-secret");
      expect(body.get("refresh_token")).toBe("1//new_token");
      expect(body.get("scope")).toContain(REQUIRED_ACP_SCOPE);
      return new Response(JSON.stringify({ access_token: "ya29.verified" }), { status: 200 });
    });

    const watcher = new GeminiCredentialsWatcher("test-instance", undefined, {
      geminiDir,
      targetTokenPath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const synced = await watcher.syncCredentials();
    expect(synced).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const tokenContent = JSON.parse(await readFile(targetTokenPath, "utf8")) as OmAcpToken;
    expect(tokenContent.refresh_token).toBe("1//new_token");
    expect(tokenContent.client_id).toBe("custom-client-id");
    expect(tokenContent.client_secret).toBe("custom-secret");
    expect(tokenContent.project_id).toBe("custom-project");
    expect(tokenContent.scopes).toContain(REQUIRED_ACP_SCOPE);
  });

  it("refuses to overwrite existing ACP token when Google rejects refresh token with invalid_scope", async () => {
    const existing: OmAcpToken = {
      client_id: "custom-client-id",
      client_secret: "custom-secret",
      refresh_token: "1//working_aicode_token",
      token_uri: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        REQUIRED_ACP_SCOPE,
      ],
      project_id: "aicode-consumers",
    };
    await writeFile(targetTokenPath, JSON.stringify(existing));
    await writeFile(join(geminiDir, "google_accounts.json"), JSON.stringify({ active: "missing-scope@example.com" }));
    await writeFile(
      join(geminiDir, "oauth_creds.json"),
      JSON.stringify({ refresh_token: "1//token_without_aicode_scope" }),
    );

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_scope", error_description: "Bad Request" }), { status: 400 }),
    );
    const switched = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const watcher = new GeminiCredentialsWatcher("test-instance", switched, {
        geminiDir,
        targetTokenPath,
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      // First attempt rejects and leaves existing token intact
      expect(await watcher.syncCredentials()).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(switched).not.toHaveBeenCalled();

      const stillWorking = JSON.parse(await readFile(targetTokenPath, "utf8")) as OmAcpToken;
      expect(stillWorking.refresh_token).toBe("1//working_aicode_token");

      // Repeated sync of the same permanently rejected token does not re-hit Google
      expect(await watcher.syncCredentials()).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Switching next to a valid aicode-scoped token succeeds
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "ya29.valid_next" }), { status: 200 }),
      );
      await writeFile(
        join(geminiDir, "oauth_creds.json"),
        JSON.stringify({ refresh_token: "1//valid_aicode_token_2" }),
      );
      expect(await watcher.syncCredentials()).toBe(true);
      expect(switched).toHaveBeenCalledTimes(1);

      const updated = JSON.parse(await readFile(targetTokenPath, "utf8")) as OmAcpToken;
      expect(updated.refresh_token).toBe("1//valid_aicode_token_2");
      expect(updated.scopes).toContain(REQUIRED_ACP_SCOPE);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps existing ACP token on transient network error and retries on subsequent sync", async () => {
    const existing: OmAcpToken = {
      client_id: "custom-client-id",
      client_secret: "custom-secret",
      refresh_token: "1//working_token",
      token_uri: "https://oauth2.googleapis.com/token",
      scopes: [REQUIRED_ACP_SCOPE],
      project_id: "aicode-consumers",
    };
    await writeFile(targetTokenPath, JSON.stringify(existing));
    await writeFile(join(geminiDir, "oauth_creds.json"), JSON.stringify({ refresh_token: "1//transient_token" }));

    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "ya29.recovered" }), { status: 200 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const watcher = new GeminiCredentialsWatcher("test-instance", undefined, {
        geminiDir,
        targetTokenPath,
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      // Transient error does not overwrite and does not permanently cache rejection
      expect(await watcher.syncCredentials()).toBe(false);
      expect((JSON.parse(await readFile(targetTokenPath, "utf8")) as OmAcpToken).refresh_token).toBe("1//working_token");

      // Next sync retries and succeeds
      expect(await watcher.syncCredentials()).toBe(true);
      expect((JSON.parse(await readFile(targetTokenPath, "utf8")) as OmAcpToken).refresh_token).toBe("1//transient_token");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resolveAcpScopes always guarantees required aicode scope", () => {
    expect(resolveAcpScopes(undefined, "openid email")).toEqual(["openid", "email", REQUIRED_ACP_SCOPE]);
    expect(resolveAcpScopes(["https://www.googleapis.com/auth/cloud-platform"], "openid")).toEqual([
      "https://www.googleapis.com/auth/cloud-platform",
      REQUIRED_ACP_SCOPE,
    ]);
    expect(resolveAcpScopes(undefined, undefined)).toContain(REQUIRED_ACP_SCOPE);
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
