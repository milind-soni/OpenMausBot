import { describe, expect, it } from "vitest";
import { excludedWorkspaceAuthPath, portableWorkspaceConfig, restoredWorkspaceConfig } from "./workspace-backup-policy.ts";

describe("workspace backup data boundary", () => {
  it("exports ordinary settings only and retains destination connection sections unchanged", () => {
    const connections = {
      xai: { key: "xai-secret", url: "https://source.example" },
      anthropic: { key: "claude-secret", url: "https://claude.example" },
      openaiCompat: { key: "api-secret", url: "https://api.example", model: "model", provider: "provider" },
      composio: { apiKey: "composio-secret", userId: "source-account", sessionId: "source-session" },
      box: { token: "box-secret" }, opencodeGo: { apiKey: "go-secret" },
      tts: { key: "voice-secret", voice: "source-voice", provider: "elevenlabs" },
      imageGen: { key: "image-secret", customApiKey: "custom-secret", customUrl: "https://images.example/v1", provider: "custom" },
      instances: { source: { driver: "claudeAgent", environment: { ORDINARY_NAME: "env-secret" }, config: { unknown: "driver-secret" } } },
      mcpServers: { source: { command: "mcp", args: ["arg-secret"], env: { ORDINARY: "env-secret" }, headers: { Authorization: "Bearer header-secret" } } },
      futureConnection: { unrecognizedField: "future-secret" }, apiKey: "legacy-secret",
      defaultModelSelection: { instanceId: "source", model: "source" },
      signIn: { admins: ["source@example.com"] }, customDomain: "source.example", vps: { sshAlias: "source" },
      cliStartup: { access: "public-url", publicUrl: "https://source.example" },
    };
    const portable = portableWorkspaceConfig({ ...connections, language: "ja", features: { browser: true }, profile: { name: "Example" } });
    expect(portable).toEqual({ profile: { name: "Example" }, language: "ja", features: { browser: true } });
    const restored = restoredWorkspaceConfig(portable, { ...connections, language: "en", budgets: { monthlyUsd: 12 } });
    expect(restored).toEqual({ ...connections, ...portable });
    expect(restored.instances).toBe(connections.instances);
  });

  it.each([
    "providers/account/.credentials.json", "providers/antigravity/profile/antigravity-acp/acp_token.json",
    "workspace-credentials.json", "browser-engine-key", "caddy/data/certificates/private.key",
    "chrome-profile/Default/Cookies", ".agent-browser/auth/site.json",
    "vm-home/.browser-profiles/chrome/Cookies", "vm-homes/abc123/.browser-profiles/chromium/Local State",
    "config.json.123.tmp", "config.json.123.05a7b3e0-1234.tmp", "sessions.json.456.tmp",
    "webhooks.json.123.05a7b3e0-1234.tmp", "browser-engine-key.12.05a7b3e0-1234.tmp",
  ])("excludes known owned authentication path %s", (path) => {
    expect(excludedWorkspaceAuthPath(path)).toBe(true);
  });

  it.each(["attachments/key.txt", "workspaces/bot/notes.md", "vm-home/project/config.json", "config.json", "webhooks.json"])("does not redact arbitrary user file %s", (path) => {
    expect(excludedWorkspaceAuthPath(path)).toBe(false);
  });
});
