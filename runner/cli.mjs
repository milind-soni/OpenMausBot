#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { VERSION, defaultConfig, atomicJson, readJson, Redactor, controllerEndpoint } from './security.mjs';
import { WorkerClient } from './protocol.mjs';
import { discoverAccounts } from './accounts.mjs';
import { Runner } from './worker.mjs';
import { install, update, rollback, requireIdle, withMaintenanceLock, pinRunnerUpdates } from './service.mjs';
import { maintainTools, rollbackManagedTool, initializeManagedAccount, managedInstallation, TOOL_PACKAGES } from './tool-updates.mjs';
import { automaticUpdatePolicy, runnerUpdatePlan } from './maintenance.mjs';
import { HerdrConnections } from './herdr-connections.mjs';

const help = `Origin runner ${VERSION} (Node24; Linux/macOS; capacity one)\n\nnode runner/cli.mjs <enroll|run|status|pause|resume|stop|install|update> [options]\n\n--config PATH          Private configuration (default ~/.config/origin-runner/config.json)\nEnrollment: --controller HTTPS_URL --name NAME --kind nixos|mac|boxd|boat\n            --tailnet-name NAME --token-file PATH (otherwise token from stdin)\nStatus:     --refresh (native account/model discovery; never sends a model prompt)\nUpdate:     --version X.Y.Z --approve, or --rollback --approve\nInstall writes user service assets only; prints explicit activation command.\nPause stops new claims; stop cancels work and leaves a durable stopped receipt.\nAccounts are bound locally via config.accounts: id,harness,executable,directory,\nprofile,provider,identity:{email,orgId},models:[{id,efforts}]. Never put raw model\nOAuth tokens in config. Model/account selections must be exact.\n`;
const toolHelp = '\nNative tool updates: update --tools --check [--tool codex|claude-code|omp|pi]\nInitialize: update --tools --tool HARNESS --initialize --account LOCAL_ID --approve\nCreates only a private dataDirectory/tools prefix; selects that executable for the\nchosen local account without changing its auth directory/profile or copying OAuth.\nApply: update --tools --approve [--tool HARNESS]\nRollback: update --tools --tool HARNESS --rollback --approve\nAutomatic: update --automatic --enable --tool codex,pi [--runner] --approve\n           [--interval-hours 24] (daily default; choose tools and/or --runner)\nDisable: update --automatic --disable --approve\nRunner check: update --check (actual latest metadata; never installs)\nSigned runner updates require owner-configured updates.baseUrl/latest.json containing\n{manifest,signature} and updates.publicKeyFile (trusted local release key).\nOnly explicitly selected, initialized Origin prefixes and signed compatible stable\nrunner releases can auto-apply, idle only. Major (0.x minor) changes require local\nexplicit approval. Failed/interrupted versions are quarantined, not retried.\nPersonal/Nix/Homebrew/global installs receive manual ownership actions only.\nStop the service before local initialization, policy changes, apply or rollback.\nRestart through the existing supervisor; no service or remote installation is started.\n';
const herdrHelp = '\nHerdr: herdr enable (Origin run consoles only), herdr enable --cloud (also renewable cloud connections)\n       herdr disable, herdr status. Disabled by default. Stop the worker before changing config;\n       restart the existing supervisor explicitly. Native desktop provider login is required.\n       Personal Herdr terminals/profiles and native authentication are never changed.\n';
async function configAt(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Runner configuration must be an owner-only regular file (chmod 600)');
  const config = await readJson(path);
  controllerEndpoint(config.controller);
  config.dataDirectory = resolve(config.dataDirectory ?? join(homedir(), '.local/share/origin-runner'));
  if (!config.hostId || !config.hostToken) throw new Error('Runner is not enrolled');
  return config;
}
async function stdinToken() {
  if (process.stdin.isTTY) {
    process.stderr.write('One-use enrollment token (hidden): ');
    return new Promise((resolve, reject) => {
      let value = '';
      const finish = error => {
        process.stdin.removeListener('data', receive);
        process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n');
        if (error) reject(error); else resolve(value.trim());
      };
      const receive = chunk => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003') { finish(new Error('Enrollment cancelled')); return; }
          if (char === '\r' || char === '\n' || char === '\u0004') { finish(); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ') value += char;
          if (value.length > 8192) { finish(new Error('Enrollment token too long')); return; }
        }
      };
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', receive);
    });
  }
  let result = ''; for await (const chunk of process.stdin) { result += chunk; if (result.length > 8192) throw new Error('Enrollment token too long'); }
  return result.trim();
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Origin runner requires Node.js 24');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' }, controller: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, 'tailnet-name': { type: 'string' }, 'token-file': { type: 'string' }, 'files-only': { type: 'boolean' }, refresh: { type: 'boolean' }, approve: { type: 'boolean' }, rollback: { type: 'boolean' }, version: { type: 'string' }, tools: { type: 'boolean' }, tool: { type: 'string' }, check: { type: 'boolean' }, initialize: { type: 'boolean' }, account: { type: 'string' }, automatic: { type: 'boolean' }, enable: { type: 'boolean' }, disable: { type: 'boolean' }, runner: { type: 'boolean' }, cloud: { type: 'boolean' }, 'interval-hours': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help + toolHelp + herdrHelp + '\nInstall: --files-only writes versioned code and an alias, without a user service.\n'); return; }
  if (positionals.length !== (command === 'herdr' ? 2 : 1)) throw new Error('Unexpected positional arguments');
  const configPath = resolve(values.config ?? defaultConfig());
  if (command === 'enroll') {
    if (values.url && values.controller && values.url !== values.controller) throw new Error('Choose one controller URL');
    values.controller ??= values.url;
    if (!values.controller) throw new Error('--url is required');
    const old = await readJson(configPath, {});
    if (old.hostToken) throw new Error('Already enrolled: refusing to replace host credentials');
    const token = values['token-file'] ? (await readFile(values['token-file'], 'utf8')).trim() : await stdinToken();
    if (!token) throw new Error('One-use enrollment token is required');
    const kind = values.kind ?? (process.platform === 'darwin' ? 'mac' : 'nixos');
    if (!['nixos', 'mac', 'boxd', 'boat'].includes(kind)) throw new Error('Invalid host kind');
    const config = { ...old, controller: values.controller, name: values.name ?? hostname(), kind, ...(values['tailnet-name'] ? { tailnetName: values['tailnet-name'] } : {}), dataDirectory: resolve(old.dataDirectory ?? join(homedir(), '.local/share/origin-runner')) };
    const accounts = await discoverAccounts(config);
    const response = await new WorkerClient(config).request('enroll', { enrollmentToken: token, host: { name: config.name, platform: process.platform, kind, version: VERSION, capabilities: [...new Set(accounts.map(value => value.binding.harness))], ...(config.tailnetName ? { tailnetName: config.tailnetName } : {}) } }, token);
    if (!response.hostId || !response.hostToken) throw new Error('Controller returned invalid enrollment receipt');
    if (response.runnerUpdates) config.updates = await pinRunnerUpdates(config, response.runnerUpdates);
    await atomicJson(configPath, { ...config, hostId: response.hostId, hostToken: response.hostToken, heartbeatSeconds: response.heartbeatSeconds ?? 15, leaseDurationSeconds: response.leaseDurationSeconds ?? 60 });
    console.log(JSON.stringify({ hostId: response.hostId, config: configPath, note: 'Enrolled. No service or model started.' }, null, 2)); return;
  }
  if (command === 'install') {
    const config = await readJson(configPath, {});
    config.dataDirectory = resolve(config.dataDirectory ?? join(homedir(), '.local/share/origin-runner'));
    console.log(JSON.stringify(await install(config, configPath, { filesOnly: values['files-only'] }), null, 2)); return;
  }
  const config = await configAt(configPath);
  if (command === 'herdr') {
    const action = positionals[1];
    if (!['enable', 'disable', 'status'].includes(action) || values.cloud && action !== 'enable') throw new Error('Use herdr enable [--cloud], herdr disable or herdr status');
    if (action !== 'status') {
      await requireIdle(config);
      await withMaintenanceLock(config, async () => {
        const current = await configAt(configPath);
        if (current.dataDirectory !== config.dataDirectory) throw new Error('Runner data directory changed; retry with the current configuration');
        current.herdr = { ...current.herdr, enabled: action === 'enable', cloudConnections: action === 'enable' && values.cloud === true };
        await atomicJson(configPath, { ...await readJson(configPath), herdr: current.herdr });
        config.herdr = current.herdr;
        if (action === 'disable' || !values.cloud) await new HerdrConnections(config).stop();
      });
    }
    console.log(JSON.stringify({ herdr: new HerdrConnections(config).report(), note: 'Local configuration only. Start the existing supervisor explicitly; personal terminals and provider authentication are unchanged.' }, null, 2)); return;
  }
  if (command === 'run') { await new Runner(config).run(); return; }
  if (command === 'status') {
    const status = await readJson(join(config.dataDirectory, 'status.json'), { state: 'not_started' });
    if (values.refresh) status.accounts = (await discoverAccounts(config)).map(value => value.report);
    const controls = await readJson(join(config.dataDirectory, 'control.json'), {});
    console.log(JSON.stringify(new Redactor([config.hostToken]).value({ ...status, localControls: controls }), null, 2)); return;
  }
  if (['pause', 'resume', 'stop'].includes(command)) {
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
    const previous = await readJson(join(config.dataDirectory, 'control.json'), {});
    await atomicJson(join(config.dataDirectory, 'control.json'), { paused: command === 'stop' ? Boolean(previous.paused) : command === 'pause', stop: command === 'stop', requestedAt: Date.now() });
    console.log(`${command} requested; status reports the acknowledged process state.`); return;
  }
  if (command === 'update' && values.automatic) {
    if (!values.approve || Boolean(values.enable) === Boolean(values.disable) || values.initialize || values.rollback || values.check || values.version) throw new Error('Automatic policy requires --enable or --disable and --approve; no other update action');
    await requireIdle(config);
    await withMaintenanceLock(config, async () => {
      const current = await configAt(configPath);
      if (current.dataDirectory !== config.dataDirectory) throw new Error('Runner data directory changed; retry with the current configuration');
      if (values.disable) current.automaticUpdates = { ...(current.automaticUpdates ?? {}), enabled: false };
      else {
        const tools = [...new Set(values.tool ? values.tool.split(',') : [])];
        for (const harness of tools) if (!TOOL_PACKAGES[harness] || !await managedInstallation(current, harness)) throw new Error(`Initialize the explicitly selected native tool first: ${harness}`);
        if (values.runner && (!current.updates?.baseUrl || !current.updates?.publicKeyFile)) throw new Error('Configure a trusted signed runner release source and local public key first');
        current.automaticUpdates = { schemaVersion: 1, enabled: true, intervalHours: values['interval-hours'] === undefined ? 24 : Number(values['interval-hours']), tools, runner: Boolean(values.runner) };
        automaticUpdatePolicy(current);
      }
      await atomicJson(configPath, current);
      config.automaticUpdates = current.automaticUpdates;
    });
    console.log(JSON.stringify({ automaticUpdates: config.automaticUpdates, note: 'Owner-local policy saved. Start the existing supervisor explicitly; no installation or model started.' }, null, 2)); return;
  }
  if (command === 'update' && values.tools) {
    if (values.version) throw new Error('Native tool apply uses checked latest-stable versions; use --rollback for a preserved prior release');
    if (values.initialize) {
      if (!values.approve || !values.tool || !values.account || values.rollback || values.check) throw new Error('Initialize requires --tool HARNESS --account LOCAL_ID --approve');
      await requireIdle(config);
      const initialized = await initializeManagedAccount(config, configPath, values.tool, values.account, true, { readConfig: configAt });
      console.log(JSON.stringify({ tool: values.tool, account: values.account, executable: initialized.executable, version: initialized.version, note: 'Private prefix initialized; selected local auth profile preserved. No OAuth files copied.' }, null, 2)); return;
    }
    if (values.rollback) console.log(JSON.stringify(await rollbackManagedTool(config, values.tool, values.approve), null, 2));
    else {
      if (!values.check && !values.approve) throw new Error('Choose --check or explicitly --approve native tool updates');
      console.log(JSON.stringify(await maintainTools(config, [], { apply: !values.check && values.approve, harness: values.tool }), null, 2));
    }
    return;
  }
  if (command === 'update') {
    if (values.check) {
      try { console.log(JSON.stringify((await runnerUpdatePlan(config)).report, null, 2)); }
      catch (error) { console.log(JSON.stringify({ component: 'origin-runner', currentVersion: VERSION, status: 'unknown', checkedAt: Date.now(), message: new Redactor([config.hostToken]).text(error.message) }, null, 2)); }
    } else console.log(JSON.stringify(values.rollback ? await rollback(config, values.approve) : await update(config, values.version, values.approve), null, 2));
    return;
  }
  throw new Error('Unknown command; use --help');
}
await main().catch(error => { console.error(`Origin runner: ${new Redactor().text(error.message)}`); process.exitCode = 1; });
