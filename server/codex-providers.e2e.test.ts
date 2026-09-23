import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("switches a bot between custom Codex providers through the isolated harness", async () => {
  const fixture = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const command = [...args, "--url", fixture.info.url];
    const result = await runControlOmb(command) as any;
    evidence.push({ command, result });
    return result;
  };
  try {
    const configPath = join(fixture.info.dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    for (const name of ["alpha", "beta"]) {
      config.instances[name] = {
        driver: "codex", displayName: name,
        config: {
          cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)),
          provider: { name, url: `https://${name}.example/v1`, models: ["fixture-model"], apiKeyEnv: "FIXTURE_KEY" },
        },
        environment: {
          HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir,
          CODEX_HOME: join(fixture.info.dataDir, name),
          FIXTURE_KEY: `${name}-synthetic-key`,
          FAKE_CODEX_DUMP: join(fixture.info.dataDir, `${name}.json`),
        },
      };
    }
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const reloaded = await fetch(`${fixture.info.url}/api/config`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModelSelection: { instanceId: "alpha", model: "fixture-model" } }),
    });
    expect(reloaded.status).toBe(200);
    const created = await control(["new-bot", "--name", "Custom provider fixture"]);
    const target = ["--bot", created.bot.id];
    for (const name of ["alpha", "beta"]) {
      await control(["set-model", ...target, "--instance", name, "--model", "fixture-model"]);
      await control(["send", ...target, "--text", `Hello ${name}; remember PROVIDER_FIXTURE.`]);
      expect((await control(["wait", ...target, "--timeout", "30"])).status).toBe("settled");
      const messages = await control(["messages", ...target, "--limit", "10"]);
      expect(JSON.stringify(messages)).toContain("done from fake codex");
      const seen = JSON.parse(readFileSync(join(fixture.info.dataDir, `${name}.json`), "utf8"));
      expect(seen.argv).toContain(`model_providers.openmaus_custom.base_url="https://${name}.example/v1"`);
      expect(seen.env.OPENMAUSBOT_CODEX_PROVIDER_API_KEY).toBe(`${name}-synthetic-key`);
      expect(seen.calls.find((call: { method: string }) => call.method === "thread/start").params)
        .toMatchObject({ model: "fixture-model", modelProvider: "openmaus_custom" });
      evidence.push({ provider: name, routingVerified: true });
    }
  } finally {
    const evidencePath = `${fixture.info.logPath}.codex-providers.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(`Codex provider evidence: ${evidencePath}`);
    await fixture.close();
  }
}, 90_000);
