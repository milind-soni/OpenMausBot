// Grok Build harness support — the official `grok` CLI over ACP stdio
// (`grok … agent stdio`), on the grok.com subscription login
// (~/.grok/auth.json), NOT the xAI API key (that driver is drivers/grok.ts).
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against grok 1.0.0.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";
import { cliText, parseGrokModels } from "../../model-discovery.ts";

const support: AcpSupport = {
  driverKind: "grokAgent",
  displayName: "Grok",
  // Mirrors `grok models` (CLI 1.0.3): 4.6 is the account default, 4.5 still
  // selectable. Static because the catalog is account-driven and we have no
  // session yet at describe() time; a new model the CLI adds needs a bump
  // here — eventually read the initialize result's _meta.modelState instead.
  models: {
    default: "grok-4.6",
    options: [
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
    ],
  },
  discoverModels: async (config, environment) => parseGrokModels(await cliText(config.cli, ["models"], { ...environment, XAI_API_KEY: undefined })),
  defaultCli: "grok",
  nativeSource: "grok.acp",
  loginNote: "Grok CLI is not signed in — run `grok login` in a terminal",

  // --permission-mode must always be explicit: ~/.grok/config.toml may set
  // permission_mode = "always-approve", which would silently make every
  // session yolo and never fire session/request_permission.
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto ? "bypassPermissions" : "default",
    ...(turn.model ? ["-m", turn.model] : []),
    "agent",
    "stdio",
  ],

  // The CLI owns its own grok.com login; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },

  // Bind the grok.com subscription login. No API-key fallback by design —
  // an unauthenticated CLI is a user action, not something to paper over.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: () => existsSync(join(homedir(), ".grok", "auth.json")),

  // `--append-system-prompt`/`--rules` are accepted by the CLI but do NOT
  // reach the agent-stdio system prompt (verified against 1.0.0), so the
  // persona is prepended codex-style.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GrokAgentDriver = createAcpDriver(support);
