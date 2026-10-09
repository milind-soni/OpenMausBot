import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const driversDir = join(root, "server/drivers");

const allowed = new Set(["claude", "codex", "opencode", "antigravity", "kimi", "openai-compat", "openai-chat"]);
let failed = false;

for (const f of readdirSync(driversDir)) {
  if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
  const base = f.replace(/\.ts$/, "");
  if (base.includes("acp") || base.includes("agents") || base.includes("chat-") || base.includes("local-")) continue;
}

const builtIn = readFileSync(join(driversDir, "builtIn.ts"), "utf8");
for (const name of ["GrokDriver", "GeminiAgentDriver", "DroidAgentDriver", "CursorAgentDriver", "QwenAgentDriver", "HermesAgentDriver", "CustomAcpDriver", "PiDriver", "MistralDriver", "CerebrasDriver", "MinimaxDriver", "BoatAgentDriver"]) {
  if (builtIn.includes(name)) {
    console.error(`FAIL: removed driver still registered: ${name}`);
    failed = true;
  }
}

const pro = readFileSync(join(root, "src/components/SettingsModal.tsx"), "utf8");
if (pro.includes("ProSettingsCard") || pro.includes('"cloudAccount"') || pro.includes("'cloudAccount'")) {
  console.error("FAIL: Pro or cloudAccount still in SettingsModal");
  failed = true;
}

if (failed) process.exit(1);
console.log("sync-upstream guard passed");
