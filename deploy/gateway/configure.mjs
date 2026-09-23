import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function gatewayConfig(key) {
  if (typeof key !== "string" || key.trim().length < 16 || /\s/.test(key)) {
    throw new Error("Set OPENMAUS_MODEL_GATEWAY_KEY to a private value of at least 16 characters without whitespace.");
  }
  const routes = [
    ["azure", "Azure / GPT", "azure-gpt"],
    ["google", "Google / Gemini 3.8 Flash", "gemini-3.8-flash"],
    ["bedrock", "Bedrock / Claude", "bedrock-claude"],
  ];
  return {
    features: { browser: true },
    defaultModelSelection: { instanceId: "google", model: "gemini-3.8-flash" },
    instances: Object.fromEntries(routes.map(([id, name, model]) => [id, {
      driver: "codex", displayName: name,
      environment: { OPENMAUS_MODEL_GATEWAY_KEY: key },
      config: { provider: {
        name, url: "http://127.0.0.1:4000/v1", apiKeyEnv: "OPENMAUS_MODEL_GATEWAY_KEY", models: [model],
      } },
    }])),
  };
}

export function writeGatewayConfig(path, key) {
  const config = gatewayConfig(key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Bootstrap only a fresh workspace. Existing user configuration is never
  // overwritten; configure its three instances through an explicit edit.
  writeFileSync(path, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, output, ...extra] = process.argv.slice(2);
  if (flag !== "--output" || !output || extra.length) {
    throw new Error("Usage: node configure.mjs --output /data/.openmausbot/config.json");
  }
  writeGatewayConfig(output, process.env.OPENMAUS_MODEL_GATEWAY_KEY);
  console.log("Created Azure GPT, Google Gemini 3.8 Flash, and Bedrock Claude instances. Gemini is the default.");
}
