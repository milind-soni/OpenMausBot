import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerBackupGateway, verifyGatewayConfig } from "../src/gateway.mjs";

test("registerBackupGateway injects antigravity-local-gateway cleanly into config.json", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-gw-"));
  const mockConfigPath = path.join(tmpDir, "config.json");
  const mockGuiConfigPath = path.join(tmpDir, "gui_config.json");

  // Create initial config.json
  const initialConfig = {
    instances: {
      antigravity: {
        driver: "antigravityAgent",
        enabled: true
      }
    }
  };
  fs.writeFileSync(mockConfigPath, JSON.stringify(initialConfig, null, 2), "utf8");

  // Create mock gui_config.json
  const mockGuiConfig = {
    proxy: {
      port: 8045,
      api_key: "sk-mock-key-for-test"
    }
  };
  fs.writeFileSync(mockGuiConfigPath, JSON.stringify(mockGuiConfig, null, 2), "utf8");

  // Execute registration
  const result = await registerBackupGateway({
    configPath: mockConfigPath,
    guiConfigPath: mockGuiConfigPath
  });

  assert.equal(result.success, true);
  assert.equal(result.instanceId, "antigravity-local-gateway");

  // Read updated config.json
  const updated = JSON.parse(fs.readFileSync(mockConfigPath, "utf8"));
  assert.ok(updated.instances["antigravity-local-gateway"]);
  const gw = updated.instances["antigravity-local-gateway"];
  assert.equal(gw.driver, "openai-compat");
  assert.equal(gw.access, "api");
  assert.equal(gw.enabled, true);
  assert.equal(gw.config.url, "http://127.0.0.1:8045/v1");
  assert.equal(gw.config.key, "sk-mock-key-for-test");
  assert.equal(gw.config.replyWaitMinutes, 5);
  assert.ok(Array.isArray(gw.config.managedModels));

  // Verify backup was made
  const files = fs.readdirSync(tmpDir);
  const backups = files.filter(f => f.includes("config.json.bak-gateway-"));
  assert.equal(backups.length, 1);

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("verifyGatewayConfig ensures native ACP instances are primary and no bot uses gateway as primary", () => {
  const cfg = {
    instances: {
      "antigravity": { driver: "antigravityAgent", enabled: true },
      "antigravity-local-gateway": { driver: "openai-compat", enabled: true }
    }
  };

  const bots = [
    {
      id: "bot-1",
      name: "Bot 1",
      modelSelection: { instanceId: "antigravity" }
    },
    {
      id: "bot-2",
      name: "Bot 2",
      modelSelection: { instanceId: "antigravity" }
    }
  ];

  const verification = verifyGatewayConfig(cfg, bots);
  assert.equal(verification.valid, true);
  assert.equal(verification.violations.length, 0);

  // If a bot had gateway as primary -> violation!
  const invalidBots = [
    {
      id: "bot-bad",
      name: "Bad Bot",
      modelSelection: { instanceId: "antigravity-local-gateway" }
    }
  ];

  const badVerification = verifyGatewayConfig(cfg, invalidBots);
  assert.equal(badVerification.valid, false);
  assert.equal(badVerification.violations.length, 1);
});
