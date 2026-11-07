// Qoder CLI, both builds: `qodercli --acp` and `qoderclicn --acp`.
//
// Verified on 2026-11-06 against qoder-cli-cn 1.1.74 on this host: `initialize` answers
// protocolVersion 1 with agentInfo {name: qoder-cli-cn, version: 1.1.74},
// promptCapabilities {image, embeddedContext}, mcpCapabilities {http, sse},
// loadSession, and sessionCapabilities {additionalDirectories, close, delete, fork, list, resume}.
// Sign-in is the CLI's own `qoderclicn login`; this driver stores no key.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { userHome } from "../../env-path.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/** Qoder's own model ids. Re-detect replaces this list with whatever the live session advertises. */
const QODER_MODELS = {
  default: "dfmodel",
  options: [
    { id: "dfmodel", label: "DeepSeek Flash" },
    { id: "dmodel", label: "DeepSeek Pro" },
    { id: "Kimi-K3.1-Pro", label: "Kimi K3.1 Pro" },
    { id: "gmodel", label: "GLM" },
    { id: "qmodel_38max", label: "Qwen 3.8 Max" },
    // QoDuck is not in the ACP model_selection the CLI advertises (it is served from Qoder's remote catalog), so
    // it only shows up here while the live probe keeps reporting six. Its id is the display name, as Qoder's own
    // free-tier model is addressed that way on the command line.
    { id: "QoDuck", label: "QoDuck (Free)" },
    // Qoder's own flagship (computer-use oriented, 8x credit multiplier). It is advertised by the remote
    // catalog rather than by the ACP model_selection, and a free account sees it in the picker but is gated
    // on use — so it lives here rather than in the live probe, same as QoDuck.
    { id: "Sonus", label: "Sonus (8×)" },
    { id: "auto", label: "Auto" },
  ],
};

const QODER_CN_MODELS = {
  default: "Kimi-K3.1-Pro",
  options: [
    { id: "Kimi-K3.1-Pro", label: "Kimi K3.1 Pro" },
    { id: "dfmodel", label: "DeepSeek Flash" },
    { id: "dmodel", label: "DeepSeek Pro" },
    { id: "glm", label: "GLM 5.3" },
    { id: "qwen", label: "Qwen 3.8" },
    { id: "auto", label: "Auto" },
  ],
};

/** `qodercli login` writes into ~/.qoder (qoderclicn into ~/.qoder-cn); the presence of the state file is the signal. */
export function qoderSignedIn(homeDir: string) {
  return (env: Record<string, string | undefined>): boolean => {
    const home = join(userHome(env), homeDir);
    return existsSync(join(home, "state.json")) || existsSync(join(home, "settings.json"));
  };
}

const QODER_INSTALL = {
  command: { darwin: "curl -fsSL https://qoder.com/install.sh | bash", linux: "curl -fsSL https://qoder.com/install.sh | bash", win32: "irm https://qoder.com/install.ps1 | iex" },
  docsUrl: "https://qoder.com",
};

const intl: AcpSupport = {
  driverKind: "qoderAgent",
  displayName: "Qoder",
  models: QODER_MODELS,
  defaultCli: "qodercli",
  nativeSource: "qoder.acp",
  loginNote: "Qoder is not signed in — run `qodercli login` in a terminal first, then return here.",
  install: QODER_INSTALL,
  // --acp is the verified entry point; -m carries the model the bot picked.
  spawnArgs: (_config, turn) => ["--acp", ...(turn.model ? ["-m", turn.model] : [])],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: qoderSignedIn(".qoder"),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

const cn: AcpSupport = {
  ...intl,
  driverKind: "qoderCnAgent",
  displayName: "Qoder CN",
  models: QODER_CN_MODELS,
  defaultCli: "qoderclicn",
  nativeSource: "qoder-cn.acp",
  loginNote: "Qoder CN is not signed in — run `qoderclicn login` in a terminal first, then return here.",
  isAuthenticated: qoderSignedIn(".qoder-cn"),
};

export const QoderDriver = createAcpDriver(intl);
export const QoderCnDriver = createAcpDriver(cn);
