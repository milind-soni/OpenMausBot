import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveAccountProxy,
  type AntigravityAccountsIndex,
} from "./antigravity-proxy.ts";

describe("resolveAccountProxy", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omb-proxy-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns undefined if activeEmailOrId is missing", async () => {
    const proxy = await resolveAccountProxy(undefined, tempDir);
    expect(proxy).toBeUndefined();
  });

  it("returns undefined if files do not exist", async () => {
    const proxy = await resolveAccountProxy("user@example.com", join(tempDir, "nonexistent"));
    expect(proxy).toBeUndefined();
  });

  it("returns undefined if proxy pool is disabled", async () => {
    const guiConfig = {
      proxy_pool: {
        enabled: false,
        proxies: [{ id: "p1", url: "http://127.0.0.1:8080", enabled: true }],
        account_bindings: { "acc-1": "p1" },
      },
    };
    const accounts: AntigravityAccountsIndex = {
      accounts: [{ id: "acc-1", email: "user@example.com" }],
    };
    await writeFile(join(tempDir, "gui_config.json"), JSON.stringify(guiConfig));
    await writeFile(join(tempDir, "accounts.json"), JSON.stringify(accounts));

    const proxy = await resolveAccountProxy("user@example.com", tempDir);
    expect(proxy).toBeUndefined();
  });

  it("returns undefined if account has proxy_disabled: true", async () => {
    const guiConfig = {
      proxy_pool: {
        enabled: true,
        proxies: [{ id: "p1", url: "http://127.0.0.1:8080", enabled: true }],
        account_bindings: { "acc-1": "p1" },
      },
    };
    const accounts: AntigravityAccountsIndex = {
      accounts: [{ id: "acc-1", email: "user@example.com", proxy_disabled: true }],
    };
    await writeFile(join(tempDir, "gui_config.json"), JSON.stringify(guiConfig));
    await writeFile(join(tempDir, "accounts.json"), JSON.stringify(accounts));

    const proxy = await resolveAccountProxy("user@example.com", tempDir);
    expect(proxy).toBeUndefined();
  });

  it("resolves proxy URL matching email and account binding", async () => {
    const guiConfig = {
      proxy_pool: {
        enabled: true,
        proxies: [
          { id: "proxy-48223", url: "http://45.149.172.129:30082", enabled: true },
          { id: "proxy-48226", url: "http://45.149.172.129:30055", enabled: true },
        ],
        account_bindings: {
          "1f6e9012-d3a5-415f-9048-b98a7330846f": "proxy-48223",
        },
      },
    };
    const accounts: AntigravityAccountsIndex = {
      accounts: [
        { id: "1f6e9012-d3a5-415f-9048-b98a7330846f", email: "frank20170808@gmail.com" },
      ],
    };
    await writeFile(join(tempDir, "gui_config.json"), JSON.stringify(guiConfig));
    await writeFile(join(tempDir, "accounts.json"), JSON.stringify(accounts));

    const proxy = await resolveAccountProxy("frank20170808@gmail.com", tempDir);
    expect(proxy).toBe("http://45.149.172.129:30082");
  });

  it("resolves proxy URL matching account id and direct proxy_id on account", async () => {
    const guiConfig = {
      proxy_pool: {
        enabled: true,
        proxies: [
          { id: "p-custom", url: "http://10.0.0.1:8888", enabled: true },
        ],
      },
    };
    const accounts: AntigravityAccountsIndex = {
      accounts: [
        { id: "uuid-999", email: "custom@example.com", proxy_id: "p-custom" },
      ],
    };
    await writeFile(join(tempDir, "gui_config.json"), JSON.stringify(guiConfig));
    await writeFile(join(tempDir, "accounts.json"), JSON.stringify(accounts));

    const proxy = await resolveAccountProxy("uuid-999", tempDir);
    expect(proxy).toBe("http://10.0.0.1:8888");
  });

  it("injects auth credentials into proxy URL when auth is provided", async () => {
    const guiConfig = {
      proxy_pool: {
        enabled: true,
        proxies: [
          {
            id: "p-auth",
            url: "http://proxy.example.com:8080",
            auth: { username: "myuser", password: "mypassword" },
            enabled: true,
          },
        ],
        account_bindings: {
          "user-1": "p-auth",
        },
      },
    };
    const accounts: AntigravityAccountsIndex = {
      accounts: [{ id: "user-1", email: "auth@example.com" }],
    };
    await writeFile(join(tempDir, "gui_config.json"), JSON.stringify(guiConfig));
    await writeFile(join(tempDir, "accounts.json"), JSON.stringify(accounts));

    const proxy = await resolveAccountProxy("auth@example.com", tempDir);
    expect(proxy).toBe("http://myuser:mypassword@proxy.example.com:8080/");
  });

  it("returns undefined if matched proxy is disabled", async () => {
    const guiConfig = {
      proxy_pool: {
        enabled: true,
        proxies: [
          { id: "p-disabled", url: "http://127.0.0.1:8080", enabled: false },
        ],
        account_bindings: {
          "user-1": "p-disabled",
        },
      },
    };
    const accounts: AntigravityAccountsIndex = {
      accounts: [{ id: "user-1", email: "disabled@example.com" }],
    };
    await writeFile(join(tempDir, "gui_config.json"), JSON.stringify(guiConfig));
    await writeFile(join(tempDir, "accounts.json"), JSON.stringify(accounts));

    const proxy = await resolveAccountProxy("disabled@example.com", tempDir);
    expect(proxy).toBeUndefined();
  });
});
