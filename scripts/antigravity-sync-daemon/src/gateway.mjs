import fs from "node:fs";
import path from "node:path";
import { GATEWAY_CONSTANTS, MANAGED_GATEWAY_MODELS } from "./types.mjs";
import { readJsonSafe, atomicWriteJson, createBackup } from "./repo.mjs";
import { resolvePaths } from "./config.mjs";

export async function registerBackupGateway(options = {}) {
  const paths = resolvePaths(options);
  const configPath = options.configPath || paths.configPath;
  const guiConfigPath = options.guiConfigPath || paths.guiConfigPath;

  const guiConfig = readJsonSafe(guiConfigPath);
  const apiKey = options.apiKey || process.env.ANTIGRAVITY_GATEWAY_API_KEY || guiConfig?.proxy?.api_key;

  if (!apiKey) {
    throw new Error(`Unable to read proxy.api_key from ${guiConfigPath} and no ANTIGRAVITY_GATEWAY_API_KEY provided`);
  }

  const port = guiConfig?.proxy?.port || GATEWAY_CONSTANTS.DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}/v1`;

  const cfg = readJsonSafe(configPath) || { instances: {} };
  if (!cfg.instances) cfg.instances = {};

  // Backup config before gateway mutation
  if (fs.existsSync(configPath)) {
    const dir = path.dirname(configPath);
    const ts = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+/, "");
    const gwBackup = path.join(dir, `config.json.bak-gateway-${ts}`);
    fs.copyFileSync(configPath, gwBackup);
  }

  cfg.instances[GATEWAY_CONSTANTS.INSTANCE_ID] = {
    driver: GATEWAY_CONSTANTS.DRIVER,
    displayName: GATEWAY_CONSTANTS.DISPLAY_NAME,
    access: GATEWAY_CONSTANTS.ACCESS,
    enabled: true,
    config: {
      url,
      key: apiKey,
      managedModels: [...MANAGED_GATEWAY_MODELS],
      replyWaitMinutes: GATEWAY_CONSTANTS.REPLY_WAIT_MINUTES
    }
  };

  await atomicWriteJson(configPath, cfg);

  return {
    success: true,
    instanceId: GATEWAY_CONSTANTS.INSTANCE_ID,
    url,
    configPath
  };
}

export function verifyGatewayConfig(cfg, bots = []) {
  const violations = [];
  const instances = cfg?.instances || {};
  const gw = instances[GATEWAY_CONSTANTS.INSTANCE_ID];

  if (!gw) {
    violations.push(`Missing instance: ${GATEWAY_CONSTANTS.INSTANCE_ID}`);
  } else if (gw.driver !== GATEWAY_CONSTANTS.DRIVER) {
    violations.push(`Invalid driver for ${GATEWAY_CONSTANTS.INSTANCE_ID}: expected ${GATEWAY_CONSTANTS.DRIVER}, got ${gw.driver}`);
  }

  // Ensure no bot uses gateway as its primary instance
  for (const bot of bots) {
    if (bot.modelSelection?.instanceId === GATEWAY_CONSTANTS.INSTANCE_ID) {
      violations.push(`Bot '${bot.name || bot.id}' has primary instance set to backup gateway '${GATEWAY_CONSTANTS.INSTANCE_ID}'. Native ACP must remain primary!`);
    }
  }

  return {
    valid: violations.length === 0,
    violations
  };
}

export async function probeGateway(url = GATEWAY_CONSTANTS.DEFAULT_URL, apiKey = "", timeoutMs = 2000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(`${url}/models`, { headers, signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return { healthy: false, status: res.status, modelCount: 0, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const count = Array.isArray(data.data) ? data.data.length : 0;
    return { healthy: true, status: 200, modelCount: count, error: null };
  } catch (err) {
    return { healthy: false, status: 0, modelCount: 0, error: err.message };
  }
}
