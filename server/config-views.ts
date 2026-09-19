// The config/instance settings surface — extracted verbatim from
// index.ts: the CLI pre-save probe (plain module functions below; they
// read only module imports) and the config views factory — configStatus,
// the admin/member projection of it, the MCP server view and persist,
// and describeInstances. index.ts wires createConfigViews at the
// helpers' original site, after managedDesktop and browserEngineSummary
// exist; the events configForAccess thunk above that site and the HTTP
// routes below read the factory's results only at request time.
import { avatarImageStatus } from "./avatar-image.ts";
import { claudeAccountInfo } from "./claude-accounts.ts";
import {
  builtInBrowserEnabled,
  claudeUserMcpEnabled,
  instanceConfigs,
  localVmMaxInstances,
  localVmMode,
  maxConcurrentBotThreads,
  roomTurnTimeoutMinutes,
  saveConfig,
  sharedComputersEnabled,
  showToolCallsEnabled,
  skillAuthoringEnabled,
  vpsSshAlias,
} from "./config.ts";
import * as composio from "./composio.ts";
import { editionStatus } from "./enterprise.ts";
import { fleetAvailable, fleetSocketPath } from "./fleet-client.ts";
import { stderrOf } from "./http.ts";
import { listMcpServers } from "./mcp-registry.ts";
import type { ManagedDesktopProviders } from "./managed-desktop.ts";
import { cfg, registry } from "./runtime.ts";
import * as tts from "./tts/index.ts";
import { augmentedPath } from "./env-path.ts";
import { describeSpawnFailure, execCli } from "./procs.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";

/** Everything the config views read from their host: the
 * managed-desktop provider set (a const in index.ts above the wiring
 * site) and the browser engine summary from the createTurnIntegrations
 * destructure. */
export interface ConfigViewsDeps {
  managedDesktop: ManagedDesktopProviders;
  browserEngineSummary(): {
    kind: "engine" | "unavailable";
    reason?: string;
    installable?: boolean;
    version?: string;
    installing?: boolean;
    installError?: string;
  };
}

/** Pre-save probe for a CLI path override: run `<cli> --version` with the
 * same environment a real turn gets (augmented PATH). Returns ok + the
 * version line, or a fail the UI can act on — ENOENT on a GUI-launched app
 * usually means "not on the app's PATH", the exact mistake this catches
 * before the override is saved. */
export async function testCliBinary(
  cli: string,
  driver: (typeof BUILT_IN_DRIVERS)[number] | undefined,
): Promise<{ ok: boolean; version?: string; message?: string; install?: (typeof BUILT_IN_DRIVERS)[number]["install"] }> {
  return new Promise((resolve) => {
    execCli(
      cli,
      ["--version"],
      {
        timeout: 10_000,
        // SIGKILL, not SIGTERM: a child that traps TERM (sh -c "trap '' TERM;
        // sleep 99999") would otherwise never fire the callback and pin the
        // HTTP socket forever. maxBuffer bounds a chatty --version too.
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 64,
        env: cliProbeEnvironment(),
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          // err.code is an errno CONSTANT ("ENOENT", "EACCES") only for spawn
          // failures; for a non-zero exit it's the exit STATUS (a number) and
          // for a timeout it's null + killed:true — describeSpawnFailure words
          // only the first kind
          const exceededBuffer = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const isSpawnError = typeof e.code === "string" && !exceededBuffer;
          const message = exceededBuffer
            ? "CLI test produced more than 64 KiB of output"
            : isSpawnError
              ? describeSpawnFailure(e, cli).message
              : e.killed
              ? "CLI test timed out after 10s"
              : `CLI exited with error ${String(e.code)}: ${(stderrOf(err) || "").slice(0, 200) || err.message.split("\n")[0]}`;
          resolve({ ok: false, message, ...(driver?.install && isSpawnError ? { install: driver.install } : {}) });
          return;
        }
        resolve({ ok: true, version: stdout.trim().split("\n")[0] });
      },
    );
  });
}

/** A pre-save probe only needs PATH. Never hand credentials inherited by the
 * desktop/server process to an arbitrary wrapper selected through Settings. */
export function cliProbeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  for (const key of [
    "XAI_API_KEY",
    "BOX_TOKEN",
    "OPENCODE_API_KEY",
    "COMPOSIO_API_KEY",
    "OMB_COMPOSIO_BROKER_TOKEN",
    "OMB_TTS_KEY",
    "OMB_FISH_AUDIO_API_KEY",
    "OMB_OPENAI_IMAGE_KEY",
    "OMB_CUSTOM_IMAGE_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ]) {
    delete env[key];
  }
  return env;
}

export function createConfigViews(deps: ConfigViewsDeps) {
  const { managedDesktop, browserEngineSummary } = deps;

  function configStatus() {
    return {
      xai: { configured: Boolean(cfg.xai?.key) },
      anthropic: { configured: Boolean(cfg.anthropic?.key) },
      // a fleet agent on this server means Settings → Workspaces has something to drive
      fleet: { available: fleetAvailable(fleetSocketPath()) },
      // what this build is entitled to, so Settings shows only what works here
      edition: (({ edition, features }) => ({ edition, features }))(editionStatus()),
      // settings, not secrets: the cap and the operator's own price list
      budgets: {
        ...(cfg.budgets?.monthlyUsd !== undefined ? { monthlyUsd: cfg.budgets.monthlyUsd } : {}),
        ...(cfg.budgets?.warnAtPercent !== undefined ? { warnAtPercent: cfg.budgets.warnAtPercent } : {}),
      },
      billing: { currency: cfg.billing?.currency ?? "USD", prices: cfg.billing?.prices ?? {} },
      // the base URL is a setting, not a secret; the key stays write-only
      openaiCompat: { configured: Boolean(cfg.openaiCompat?.key), url: cfg.openaiCompat?.url ?? "" },
      composio: {
        configured: composio.configured(cfg),
        mode: composio.connectionMode(cfg),
      },
      box: { configured: Boolean(cfg.box?.token) },
      vps: { configured: Boolean(vpsSshAlias(cfg)), sshAlias: vpsSshAlias(cfg) ?? "" },
      opencodeGo: { configured: Boolean(cfg.opencodeGo?.apiKey) },
      // the chosen voice is a setting, not a secret; the key is reported the
      // same configured-or-not way as every other credential
      tts: tts.describeVoice(cfg),
      imageGen: avatarImageStatus(cfg),
      // not a secret — the sidebar shows it
      profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
      // not a secret — the settings picker shows it; "" = follow the system
      language: cfg.language ?? "",
      rooms: { turnTimeoutMinutes: roomTurnTimeoutMinutes(cfg) },
      threads: { maxConcurrentPerBot: maxConcurrentBotThreads(cfg) },
      localVm: {
        mode: localVmMode(cfg),
        maxInstances: localVmMaxInstances(cfg),
      },
      features: {
        skillAuthoring: skillAuthoringEnabled(cfg),
        showToolCalls: showToolCallsEnabled(cfg),
        browser: builtInBrowserEnabled(cfg),
        // Maintainer-only escape hatch, not a Settings toggle: the desktop
        // shell and the Settings UI read it so they offer nothing this server
        // would refuse.
        sharedComputers: sharedComputersEnabled(cfg),
        // Plugins → MCP servers switch: Claude bots also see this machine's
        // own Claude Code MCP servers
        claudeUserMcp: claudeUserMcpEnabled(cfg),
      },
      // first-run progress — not a secret; the app decides whether to show
      // the welcome tour from this, never from browser storage
      onboarding: {
        completedAt: cfg.onboarding?.completedAt ?? "",
        version: cfg.onboarding?.version ?? 0,
        reelSeen: cfg.onboarding?.reelSeen === true,
        hintsSeen: cfg.onboarding?.hintsSeen ?? [],
      },
      // Which browser this server can give bots: the desktop app's surface,
      // the agent-browser engine, or nothing yet (with the reason).
      browserEngine: browserEngineSummary(),
      // partitionId is non-secret routing metadata. The renderer needs it to
      // show the same durable session as an agent, but config PATCH validation
      // keeps it read-only and rejects callers that try to choose it.
      browserProfiles: cfg.browserProfiles ?? [],
      // who may sign in with an emailed code (server/account-signin.ts)
      signIn: { admins: cfg.signIn?.admins ?? [], members: cfg.signIn?.members ?? [] },
    };
  }

  function configForAccess(status: ReturnType<typeof configStatus>, admin: boolean) {
    if (admin) return status;
    // Configured-or-not is fine; an SSH alias, an email, a browser partition
    // id, and the sign-in list are not a client's business. Preserve the
    // source objects.
    return {
      ...status,
      signIn: { admins: [], members: [] },
      vps: { configured: status.vps.configured, sshAlias: "" },
      profile: { name: status.profile.name, email: "" },
      browserProfiles: status.browserProfiles.map((profile) => Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "partitionId"))),
    };
  }

  function mcpServerResponse() {
    return { servers: listMcpServers(cfg.mcpServers) };
  }

  /** The fields a new server may set, in whichever shape the form sent — a
   * command to run or a URL to reach. Absent keys stay absent, so the strict
   * schema of one shape never sees the other shape's `undefined`s. */
  function mcpServerBody(body: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!body || typeof body !== "object") return out;
    const record = body as Record<string, unknown>;
    for (const key of ["command", "args", "env", "type", "url", "headers", "enabled"]) {
      if (record[key] !== undefined) out[key] = record[key];
    }
    return out;
  }

  function persistMcpServers(next: Record<string, unknown>): void {
    saveConfig({ mcpServers: next });
    // Do not reload the provider fleet: integrations are assembled from cfg at
    // the next turn boundary. Updating this property directly also correctly
    // clears the final entry; Object.assign(loadConfig()) would leave it stale
    // when an empty section is omitted by an older config file.
    cfg.mcpServers = next;
  }

  async function describeInstances() {
    const configs = instanceConfigs(cfg);
    return (await registry.describe()).map((instance) => {
      const entry = configs[instance.instanceId];
      const described = entry?.icon ? { ...instance, icon: entry.icon } : instance;
      if (managedDesktop.owns(instance.instanceId)) return {
        ...described, readOnly: true, managed: managedDesktop.info(instance.instanceId),
        install: undefined, authentication: undefined, cli: undefined, cliCandidates: [],
      };
      if (entry?.driver !== "claudeAgent") return described;
      try {
        const claudeAccount = claudeAccountInfo(instance.instanceId, entry, instance.cli ?? instance.cliDefault ?? "claude");
        return { ...described, claudeAccount, install: { ...instance.install, signInCommand: claudeAccount.signInCommand } };
      } catch {
        // A malformed saved config remains a repairable shadow, never takes
        // the model picker down or offers a login for the wrong directory.
        return { ...described, install: { ...instance.install, signInCommand: undefined } };
      }
    });
  }

  return { configStatus, configForAccess, mcpServerResponse, mcpServerBody, persistMcpServers, describeInstances };
}
