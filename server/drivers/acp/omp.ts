// OMP over ACP (`omp acp`), checked against 18.13.1: initialize offers the `agent` auth method,
// session load, images and HTTP MCP; session/new exposes model and model-specific thinking options.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../../credential-env.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { discoverAcpModels, type AcpDiscoveryOptions } from "./custom-model-catalog.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };
const AGENT_DEFAULT = { id: "agent-default", label: "OMP default (configured)" };
const WORKSPACE_CREDENTIALS = new Set<string>(WORKSPACE_CREDENTIAL_ENV);
const CREDENTIAL_ENV = PROVIDER_CREDENTIAL_ENV.filter((key) => !WORKSPACE_CREDENTIALS.has(key));
// ponytail: variant probing stops at 128 models; add cached background surveys if large catalogs need every list upfront.
const DISCOVERY: AcpDiscoveryOptions = { passthrough: AGENT_DEFAULT, custom: true, variants: true, variantLimit: 128, maxModels: 4096 };

export async function resolveOmpModels(
  env: Record<string, string | undefined>,
  config: Pick<AcpConfig, "cli">,
): Promise<ModelCatalog> {
  const sessionDir = await mkdtemp(join(tmpdir(), "omb-omp-discovery-"));
  try {
    return await discoverAcpModels({ ...env, PI_CODING_AGENT_SESSION_DIR: sessionDir }, config.cli, ["acp"], DISCOVERY);
  } finally {
    await rm(sessionDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

const SUPPORT: AcpSupport = {
  driverKind: "ompAgent",
  displayName: "OMP",
  access: "custom",
  models: EMPTY,
  defaultCli: "omp",
  cliVersion: /\bomp\//i,
  nativeSource: "omp.acp",
  images: true,
  loginNote: "OMP has no usable models. Run `omp login` or configure a provider in `~/.omp/agent/models.yml`, then check again.",
  install: {
    command: {
      darwin: "npm install -g @oh-my-pi/pi-coding-agent",
      linux: "npm install -g @oh-my-pi/pi-coding-agent",
      win32: "npm install -g @oh-my-pi/pi-coding-agent",
    },
    needsNode: true,
    docsUrl: "https://omp.sh",
    signInCommand: "omp login",
  },
  spawnArgs: () => ["acp"],
  credentialEnv: CREDENTIAL_ENV,
  resolveModels: resolveOmpModels,
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: AGENT_DEFAULT.id },
  modelVariants: true,
  ownMcpOverHttp: true,
  pickAuthMethod: (methods) => methods.some((method) => method.id === "agent") ? "agent" : null,
  authFailure: "continue",
  isAuthenticated: () => true,
};

export const OmpAgentDriver = createAcpDriver(SUPPORT);
