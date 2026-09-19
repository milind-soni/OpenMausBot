// The codex provider snapshot: CLI presence/version, sign-in status, the
// display account email, and the update notice. The explicit-deps half of
// the driver's snapshot closure (acp pattern): the env builder and model
// catalog stay with the driver instance.
import type { ProviderSnapshot } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { STATIC_CODEX_MODELS } from "../codex-catalog.ts";
import { codexAccountEmail } from "../codex-identity.ts";
import type { CodexConfig } from "./config.ts";
import { codexAstraUpdate } from "./update.ts";

export async function codexSnapshot(options: {
  config: CodexConfig;
  env: Record<string, string | undefined>;
  companyAuthenticated: boolean;
  models: typeof STATIC_CODEX_MODELS;
}): Promise<ProviderSnapshot> {
  const { config, env, companyAuthenticated, models } = options;
  const version = await new Promise<string | null>((resolve) => {
    execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    );
  });
  if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
  if (config.managed) return { state: "available", version, authenticated: companyAuthenticated, billing: "metered" };
  const authenticated = await new Promise<boolean>((resolve) => {
    execCli(config.cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) =>
      resolve(!err && /^logged in\b/im.test(`${stdout}\n${stderr ?? ""}`)),
    );
  });
  // Display identity only, so Settings can say whose ChatGPT account the
  // bots run on; the status command above stays the authority on sign-in.
  const email = authenticated ? await codexAccountEmail(config.cli, env) : null;
  // childEnv drops OPENAI_API_KEY on purpose — turns run on the ChatGPT login
  return {
    state: "available",
    version,
    authenticated,
    ...(email ? { account: { email } } : {}),
    update: codexAstraUpdate(version, models, config.cli),
    billing: "subscription",
  };
}
