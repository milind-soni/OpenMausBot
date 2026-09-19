// The provider-instance ("model picker") HTTP routes, extracted verbatim from
// index.ts's dispatch chain. Path matching, methods, and status codes are
// unchanged; the handler returns false for anything it does not own so the
// chain falls through in the same order. The family covers the engine picker,
// per-instance auth flows, CLI discovery and the pre-save probe, Claude Code
// self-update, and the per-instance settings PATCH/DELETE. The
// providerConfigBusy flag is shared with the config-write routes that stay in
// index.ts, so it crosses as an accessor pair; the auth-session registry, the
// fleet's persist/changing pair, and the config views cross through deps.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { cfg, registry, store } from "../runtime.ts";
import { botForThread, threadBusy } from "../turn-admission.ts";
import {
  configuredAccountDirectory,
  assertSeparateClaudeAccount,
  createClaudeAccountSchema,
  instanceSettingsSchema,
  newClaudeAccount,
} from "../claude-accounts.ts";
import { persistableInstanceConfigs, saveConfig, withInstanceCli } from "../config.ts";
import { findCliCandidates, resetPathCache } from "../env-path.ts";
import { updateClaudeCli } from "../claude-update.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { providerIconPatchSchema, withInstanceIcon } from "../provider-icon.ts";
import { providerIconError } from "../../shared/provider-icon.ts";
import { cliProbeEnvironment, testCliBinary, type createConfigViews } from "../config-views.ts";
import type { createProviderFleet } from "../provider-fleet.ts";
import type { createGroupTurnOperations } from "../group-turn-operations.ts";
import type { ProviderAuthSessions } from "../provider-auth-sessions.ts";
import type { SessionRegistry } from "../sessions.ts";

// One updater per executable: multiple Claude instances can point at the same
// install, and running two self-updates against it would race its files.
const claudeUpdatesInFlight = new Set<string>();

export function createInstanceRoutes(deps: {
  providerConfigBusy: { get: () => boolean; set: (value: boolean) => void };
  providerAuthSessions: ProviderAuthSessions;
  sessions: SessionRegistry;
  describeInstances: ReturnType<typeof createConfigViews>["describeInstances"];
  configStatus: ReturnType<typeof createConfigViews>["configStatus"];
  persistProviderInstance: ReturnType<typeof createProviderFleet>["persistProviderInstance"];
  providerInstancesChanging: ReturnType<typeof createProviderFleet>["providerInstancesChanging"];
  activeGroupTurnForBot: ReturnType<typeof createGroupTurnOperations>["activeGroupTurnForBot"];
  broadcast(payload: Record<string, unknown>): void;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url, auth } = rctx;
    const {
      providerConfigBusy, providerAuthSessions, sessions, describeInstances, configStatus, broadcast,
      persistProviderInstance, providerInstancesChanging, activeGroupTurnForBot,
    } = deps;
    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      // Rescan PATH first: this endpoint is how the app answers "what can I
      // run?", and the interesting case is a CLI installed since launch.
      // Windows never pushes PATH changes into a live process, so without
      // this the answer is frozen at boot and "check again" is a no-op.
      resetPathCache();
      json(res, 200, { instances: await describeInstances() });
      return true;
    }
    const companyMutation = /^\/api\/instances\/(company\.[\w.-]+)(?:\/|$)/.exec(path);
    if (companyMutation && method !== "GET") {
      json(res, 403, { error: "Company accounts are read-only here. Manage this connection in desktop Settings." });
      return true;
    }

    if (method === "POST" && path === "/api/instances/claude-accounts") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const parsed = createClaudeAccountSchema.safeParse(await readBody(req, 8192));
      if (!parsed.success) {
        json(res, 400, { error: "Enter an account name (up to 80 characters) and an optional configuration directory." });
        return true;
      }
      if (providerConfigBusy.get()) {
        json(res, 409, { error: "provider settings are already being updated" });
        return true;
      }
      providerConfigBusy.set(true);
      try {
        const { instanceId, instances } = newClaudeAccount(cfg, parsed.data);
        await persistProviderInstance(instanceId, instances);
        json(res, 201, { instanceId, instances: await describeInstances() });
        return true;
      } finally { providerConfigBusy.set(false); }
    }

    const authStatus = /^\/api\/instances\/([\w.-]+)\/auth\/status$/.exec(path);
    if (method === "GET" && authStatus) {
      res.setHeader("cache-control", "no-store");
      const state = await providerAuthSessions.status(authStatus[1], auth.kind === "session" ? auth.session.id : "loopback", url.searchParams.get("flowId") ?? "");
      json(res, 200, { auth: state });
      return true;
    }
    const instanceAction = /^\/api\/instances\/([\w.-]+)\/(refresh-models|install|auth\/start|auth\/complete|auth\/cancel|auth\/sign-out)$/.exec(path);
    if (method === "POST" && instanceAction) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const instanceId = instanceAction[1];
      const action = instanceAction[2];
      const owner = auth.kind === "session" ? auth.session.id : "loopback";
      if (action.startsWith("auth/")) res.setHeader("cache-control", "no-store");
      try {
        if (action === "refresh-models") {
          if (!(await registry.refreshModels(instanceId))) {
            json(res, 404, { error: "unknown instance" });
            return true;
          }
          json(res, 200, { instances: await describeInstances() });
          return true;
        }
        if (action === "install") {
          if (!(await registry.installRuntime(instanceId))) {
            json(res, 404, { error: "Installing this engine from Settings is not available on this server. Use the install command on the machine running OpenMausBot." });
            return true;
          }
          json(res, 200, { instances: await describeInstances() });
          return true;
        }
        if (action === "auth/start") {
          const instance = registry.get(instanceId);
          if (!instance) {
            json(res, 404, { error: "unknown instance" });
            return true;
          }
          const started = await providerAuthSessions.start(instance, owner);
          // Revocation can arrive while the CLI is obtaining a device code.
          if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
            providerAuthSessions.revokeOwner(owner);
            json(res, 401, { error: "Your session ended. Start a new sign-in." });
            return true;
          }
          json(res, 200, { auth: started });
          return true;
        }
        if (action === "auth/sign-out") {
          const instance = registry.get(instanceId);
          if (!instance) {
            json(res, 404, { error: "unknown instance" });
            return true;
          }
          await providerAuthSessions.signOut(instance, owner);
          json(res, 200, { instances: await describeInstances() });
          return true;
        }
        if (action === "auth/complete") {
          const body = await readBody(req);
          const flowId = typeof body?.flowId === "string" ? body.flowId : "";
          // `code` for a pasted sign-in code (Claude), `callbackUrl` for a browser callback
          const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl : typeof body?.code === "string" ? body.code : "";
          if (!flowId || !callbackUrl) {
            json(res, 400, { error: "flowId and a code or callbackUrl are required" });
            return true;
          }
          await providerAuthSessions.complete(instanceId, owner, flowId, callbackUrl);
          json(res, 200, { ok: true });
          return true;
        }
        const body = await readBody(req, 4096);
        await providerAuthSessions.cancel(instanceId, owner, typeof body?.flowId === "string" ? body.flowId : "");
        json(res, 200, { ok: true });
        return true;
      } catch (error) {
        const requestedStatus = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
        const status = typeof requestedStatus === "number" && [400, 401, 404, 409, 413, 415].includes(requestedStatus) ? requestedStatus : 500;
        json(res, status, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
    }

    // ── CLI binary discovery for the Engines "detected" dropdown ──
    // ?name=claude → absolute paths of every `claude` on the augmented PATH,
    // in PATH order (first = what a bare name runs). Polled when the user
    // opens the Custom picker so a just-installed CLI appears without a restart.
    if (method === "GET" && path === "/api/cli-candidates") {
      const name = url.searchParams.get("name") ?? "";
      resetPathCache();
      json(res, 200, { candidates: findCliCandidates(name) });
      return true;
    }

    // ── pre-save CLI probe: does this path actually run? ──
    // POST {cli, driver} → spawn `<cli> --version` with the same PATH the
    // turn itself would use. A miss here (typo, missing exec bit, a binary
    // the GUI app can't see) means every turn would fail, so the UI asks
    // before saving rather than registering a dead engine.
    if (method === "POST" && path === "/api/cli-test") {
      // same gate as the local-VM lifecycle routes: this executes a local
      // binary, so a hostile page must not be able to submit it as a simple
      // text/plain cross-origin request
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const body = await readBody(req);
      const cli = typeof body?.cli === "string" ? body.cli.trim() : "";
      if (!cli || /[\n\r]/.test(cli)) {
        json(res, 400, { error: "cli must be a non-empty path" });
        return true;
      }
      const driver = typeof body?.driver === "string" ? BUILT_IN_DRIVERS.find((d) => d.driverKind === body.driver) : undefined;
      // Probe the exact configured wrapper plus --version. testCliBinary uses
      // a credential-redacted environment, so fixed wrapper arguments cannot
      // turn this endpoint into an inherited-secret reader.
      const probe = await testCliBinary(cli, driver);
      json(res, 200, probe);
      return true;
    }

    // ── instance-scoped Claude Code update ──
    // No command or path comes from the request: the registry supplies the
    // executable already configured for this Claude instance. The JSON gate
    // keeps a hostile page from triggering a local process with a simple
    // cross-origin form request.
    const busyProviderSelections = () => store.bots.flatMap((bot) => {
      const busyTasks = store.tasks(bot.id).filter((task) => threadBusy(bot.id, task.threadId));
      const selections = busyTasks.map((task) => botForThread(bot.id, task.threadId)!.modelSelection);
      // Rooms still run from the profile default; a direct thread does not.
      if (activeGroupTurnForBot(bot.id) || (bot.busy && busyTasks.length === 0)) selections.push(bot.modelSelection);
      return selections;
    });
    const claudeUpdate = /^\/api\/instances\/([\w.-]+)\/claude-update$/.exec(path);
    if (method === "POST" && claudeUpdate) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      await readBody(req);
      const target = registry.cliTarget(claudeUpdate[1]);
      if (!target) {
        json(res, 404, { error: "no such provider instance" });
        return true;
      }
      if (target.driverKind !== "claudeAgent") {
        json(res, 400, { error: "only Claude Code instances can be updated here" });
        return true;
      }
      if (!target.cli) {
        json(res, 409, { error: "this Claude instance has no configured executable" });
        return true;
      }
      if (claudeUpdatesInFlight.has(target.cli)) {
        json(res, 409, { error: "this Claude installation is already updating" });
        return true;
      }
      const active = busyProviderSelections().some((selection) => registry.cliTarget(selection.instanceId)?.cli === target.cli);
      if (active) {
        json(res, 409, { error: "wait for running Claude tasks to finish before updating" });
        return true;
      }

      claudeUpdatesInFlight.add(target.cli);
      try {
        const result = await updateClaudeCli(target.cli, cliProbeEnvironment());
        resetPathCache();
        json(res, 200, { ok: true, version: result.version });
        return true;
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        return true;
      } finally {
        claudeUpdatesInFlight.delete(target.cli);
      }
    }

    // ── per-instance settings (CLI/account or API tool support) ──
    // PATCH /api/instances/:id {cli: "/path/to/cli" | ""} — "" reverts to the
    // driver default. Only this idle instance is replaced; siblings keep running.
    const instanceIconPatch = /^\/api\/instances\/([\w.-]+)\/icon$/.exec(path);
    if (method === "PATCH" && instanceIconPatch) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const parsed = providerIconPatchSchema.safeParse(await readBody(req, 192 * 1024));
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        json(res, 400, { error: detail && detail !== "Invalid input" ? detail : "Choose a built-in icon or upload a PNG, JPEG, or WebP image up to 128 KB." });
        return true;
      }
      if (parsed.data.icon) {
        const invalid = providerIconError(parsed.data.icon);
        if (invalid) {
          json(res, 400, { error: invalid });
          return true;
        }
      }
      if (providerConfigBusy.get()) {
        json(res, 409, { error: "provider settings are already being updated" });
        return true;
      }
      providerConfigBusy.set(true);
      try {
        const changed = withInstanceIcon(cfg, instanceIconPatch[1], parsed.data.icon);
        if (!changed.ok) {
          json(res, 404, { error: `unknown instance "${instanceIconPatch[1]}"` });
          return true;
        }
        saveConfig({ instances: changed.instances }, { replaceInstances: true });
        cfg.instances = changed.instances;
        broadcast({ kind: "config", ...configStatus() });
        json(res, 200, { instances: await describeInstances() });
        return true;
      } finally { providerConfigBusy.set(false); }
    }

    const instancePatch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
    if (method === "PATCH" && instancePatch) {
      // same non-simple-request gate as the local-VM lifecycle routes
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const parsed = instanceSettingsSchema.safeParse(await readBody(req, 16384));
      if (!parsed.success) {
        json(res, 400, { error: "Supply a valid CLI path, account name, configuration directory or boolean tools setting." });
        return true;
      }
      const body = parsed.data;
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) {
        json(res, 409, { error: "provider settings are already being updated" });
        return true;
      }
      if (busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        json(res, 409, { error: "Wait for bots using this account to finish before changing its settings." });
        return true;
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        const result = body.cli === undefined ? { ok: true, config: cfg } : withInstanceCli(cfg, instanceId, body.cli);
        const instances = persistableInstanceConfigs(result.config);
        if (!result.ok || !Object.hasOwn(instances, instanceId)) {
          json(res, 404, { error: `unknown instance "${instanceId}"` });
          return true;
        }
        const entry = instances[instanceId];
        if ((body.displayName !== undefined || body.configDir !== undefined) && entry.driver !== "claudeAgent") {
          json(res, 400, { error: "Account settings are currently available for Claude only." });
          return true;
        }
        if (body.tools !== undefined) {
          if (!["openai-compat", "grok", "minimax"].includes(entry.driver)) {
            json(res, 400, { error: "The tools setting is available for OpenAI-compatible, Grok API and MiniMax API instances only." });
            return true;
          }
          entry.config = { ...entry.config as Record<string, unknown>, tools: body.tools };
        }
        if (body.displayName !== undefined) entry.displayName = body.displayName;
        if (body.configDir !== undefined) {
          let previousDir: string | undefined;
          try { previousDir = configuredAccountDirectory(entry); } catch { /* Allow repairing an unused malformed account. */ }
          entry.config = { ...entry.config as Record<string, unknown>, configDir: body.configDir };
          if (previousDir !== configuredAccountDirectory(entry)) {
            const used = store.bots.some((bot) => bot.modelSelection.instanceId === instanceId || store.tasks(bot.id).some((task) =>
              task.modelSelection?.instanceId === instanceId || task.resumeCursors[instanceId] || task.lastInstanceId === instanceId));
            if (used) {
              json(res, 409, { error: "This account is used by bots or conversation history. Add another account and select it for the bot instead." });
              return true;
            }
            assertSeparateClaudeAccount(instances, instanceId, entry);
          }
        }
        await persistProviderInstance(instanceId, instances);
        json(res, 200, { instances: await describeInstances() });
        return true;
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }

    if (method === "DELETE" && instancePatch) {
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) {
        json(res, 409, { error: "provider settings are already being updated" });
        return true;
      }
      const instances = persistableInstanceConfigs(cfg);
      if (!Object.hasOwn(instances, instanceId)) {
        json(res, 404, { error: "unknown instance" });
        return true;
      }
      if (instances[instanceId].driver !== "claudeAgent" || instanceId === "claude") {
        json(res, 400, { error: "Only added Claude accounts can be removed here." });
        return true;
      }
      if (cfg.defaultModelSelection?.instanceId === instanceId || store.bots.some((bot) =>
        bot.modelSelection.instanceId === instanceId || store.tasks(bot.id).some((task) => task.modelSelection?.instanceId === instanceId)) ||
        busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        json(res, 409, { error: "Choose another account for the bots and default model using this account before removing it." });
        return true;
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        delete instances[instanceId];
        await persistProviderInstance(instanceId, instances);
        json(res, 200, { instances: await describeInstances() });
        return true;
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }
    return false;
  };
}
