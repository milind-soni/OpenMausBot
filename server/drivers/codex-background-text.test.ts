import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexDriver } from './codex.ts';
import type { ProviderInstance } from '../contracts.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { createMemoryUpkeep } from '../memory-upkeep.ts';
import { workspaceDir } from '../workspace.ts';
import { flushMemoryJournal } from '../memory-journal.ts';
import { ChatGptPlanAuthController } from './chatgpt-plan-auth.ts';

const cli = fileURLToPath(new URL('../testing/fake-codex-app-server.ts', import.meta.url));

describe('Codex background text generation (isolated app-server)', () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let dump: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'omb-codex-background-'));
    dump = join(scratch, 'calls.json');
    mkdirSync(join(scratch, '.codex'));
    chmodSync(cli, 0o755);
  });
  afterEach(async () => { await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); await removeTempDir(scratch); });
  const create = async (mode = 'background-text', environment: Record<string, string> = {}, config = {}) => {
    instance = await CodexDriver.create({
      instanceId: 'background-fixture', displayName: 'Fixture', enabled: true,
      config: { cli, fullAuto: false, ...config },
      environment: { HOME: scratch, USERPROFILE: scratch, CODEX_HOME: join(scratch, '.codex'),
        FAKE_CODEX_MODE: mode, FAKE_CODEX_DUMP: dump, ...environment },
    });
    return instance;
  };
  const waitForTurn = () => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!existsSync(dump)) return;
      try {
        if (JSON.parse(readFileSync(dump, 'utf8')).calls.some((call: {method: string}) => call.method === 'turn/start')) {
          watcher.close(); clearTimeout(timer); resolve();
        }
      } catch { /* Atomic replacement may briefly be unavailable on Windows. */ }
    };
    const watcher = watch(dirname(dump), check);
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Fixture turn did not start')); }, 10000);
    check();
  });

  it('extracts text without publishing helper events and books actual usage', async () => {
    const engine = await create();
    const listener = vi.fn(); engine.adapter.onEvent(listener);
    const onUsage = vi.fn();
    expect(await engine.generateText!('Extract a preference', {onUsage})).toBe('background result');
    expect(listener).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ model: 'gpt-fake-default', input: 7, output: 3, cachedInput: 2 });
    const seen = JSON.parse(readFileSync(dump, 'utf8'));
    const start = seen.calls.find((call: {method: string}) => call.method === 'thread/start');
    expect(start.params).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', modelProvider: 'openai' });
    expect(start.params.config['mcp_servers."harmless_name".enabled']).toBe(false);
    expect(seen.argv).toContain('features.shell_tool=false');
    expect(seen.argv.join(' ')).not.toContain('Extract a preference');
    expect(engine.reviewPermission).toBeUndefined();
  });
  it.each(['background-text-tool', 'background-text-approval'])('rejects tool/approval requests in %s', async mode => {
    const engine = await create(mode);
    await expect(engine.generateText!('Only text')).rejects.toThrow(/non-text action|tool or approval/);
  });
  it('books the server-resolved helper model', async () => {
    const engine = await create('background-text', {FAKE_CODEX_BACKGROUND_MODEL: 'resolved-model'});
    const onUsage = vi.fn();
    await engine.generateText!('A model alias', {onUsage});
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({model: 'resolved-model'}));
  });
  it('keeps generic helper calls out of foreground fake-provider evidence', async () => {
    const engine = await create('happy', {FAKE_CODEX_ROOM_PLAN: join(scratch, 'must-not-read-room-plan.json')});
    const foreground = JSON.stringify({fixture: 'foreground turn evidence'});
    writeFileSync(dump, foreground);
    expect(await engine.generateText!('A background title')).toBe('background result');
    expect(readFileSync(dump, 'utf8')).toBe(foreground);
  });
  it('uses ChatGPT plan authentication and its catalog model without an API-key fallback', async () => {
    vi.spyOn(ChatGptPlanAuthController.prototype, 'models').mockResolvedValue({default: 'plan-model', options: [{id: 'plan-model', label: 'Fixture'}]});
    const token = vi.spyOn(ChatGptPlanAuthController.prototype, 'accessToken').mockResolvedValue('synthetic-plan-token');
    const engine = await create('background-text', {OPENAI_API_KEY: 'synthetic-api-key'}, {authMode: 'chatgpt-plan'});
    const onUsage = vi.fn();
    expect(await engine.generateText!('Only the selected account', {onUsage})).toBe('background result');
    expect(token).toHaveBeenCalledOnce();
    const seen = JSON.parse(readFileSync(dump, 'utf8'));
    expect(seen.env.OPENMAUSBOT_CHATGPT_TOKEN).toBe('synthetic-plan-token');
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.argv.join(' ')).not.toContain('synthetic-plan-token');
    expect(seen.calls.find((call: {method: string}) => call.method === 'thread/start').params)
      .toMatchObject({model: 'plan-model', modelProvider: 'openai_chatgpt_plan'});
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({model: 'plan-model'}));
  });
  it('refuses a ChatGPT plan helper when its catalog contains no model', async () => {
    vi.spyOn(ChatGptPlanAuthController.prototype, 'models').mockResolvedValue({default: '', options: []});
    const token = vi.spyOn(ChatGptPlanAuthController.prototype, 'accessToken').mockResolvedValue('unused-token');
    const engine = await create('background-text', {}, {authMode: 'chatgpt-plan'});
    await expect(engine.generateText!('Do not run')).rejects.toThrow(/No model available/);
    expect(token).not.toHaveBeenCalled();
    expect(existsSync(dump)).toBe(false);
  });
  it('retains Company routing and refuses missing Company credentials', async () => {
    const config = {managed: {url: 'http://127.0.0.1:1/v1', models: ['company-model']}};
    const engine = await create('background-text', {OPENMAUSBOT_COMPANY_API_KEY: 'synthetic-company-key'}, config);
    expect(await engine.generateText!('Company only')).toBe('background result');
    const seen = JSON.parse(readFileSync(dump, 'utf8'));
    expect(seen.calls.find((call: {method: string}) => call.method === 'thread/start').params)
      .toMatchObject({model: 'company-model', modelProvider: 'openmaus_company'});
    await engine.dispose();
    const missing = await create('background-text', {}, config);
    await expect(missing.generateText!('No fallback')).rejects.toThrow(/Company model credentials/);
  });
  it('fails closed when the requested sandbox was not applied', async () => {
    const engine = await create('background-text', {FAKE_CODEX_RESOLVED_SANDBOX: '{"type":"dangerFullAccess"}'});
    await expect(engine.generateText!('Do not run')).rejects.toThrow(/read-only sandbox/);
    const seen = JSON.parse(readFileSync(dump, 'utf8'));
    expect(seen.calls.some((call: {method: string}) => call.method === 'turn/start')).toBe(false);
  });
  it('honors cancellation before launching', async () => {
    const engine = await create();
    const controller = new AbortController(); controller.abort();
    await expect(engine.generateText!('Do not run', {signal: controller.signal})).rejects.toThrow(/aborted/);
  });
  it('refuses inference when Codex ignores native-tool disabling', async () => {
    const engine = await create('background-text', {FAKE_CODEX_IGNORE_FEATURES: '1'});
    await expect(engine.generateText!('Do not run')).rejects.toThrow(/tool disabling/);
    // The fake writes this file at thread/start, so no file proves that even
    // creating the inference session was refused after config/read.
    expect(existsSync(dump)).toBe(false);
  });
  it('captures a preference into memory and About me through the real upkeep pipeline', async () => {
    const engine = await create('background-text', {FAKE_CODEX_TEXT_REPLY: JSON.stringify([
      {text: 'The person prefers tea.', kind: 'preference', aboutUser: true, confidence: 0.95},
    ])});
    const bot = {id: 'codex-memory-fixture', name: 'Fixture'};
    const aboutMe: string[] = [];
    const upkeep = createMemoryUpkeep({
      bots: () => [bot], bot: () => bot, engine: () => engine, busy: () => false,
      addToAboutMe: (_from, facts) => {aboutMe.push(...facts); return facts.length;},
      sourceLabel: () => 'chat "Fixture"', quietMs: () => 60000, tidyHour: () => 3,
    });
    try {
      expect(upkeep.status(bot.id).modelSteps).toBe(true);
      const report = await upkeep.capture({botId: bot.id, threadId: 'fixture-chat', turns: [{person: 'I prefer tea.', bot: 'Understood.'}]});
      expect(report).toMatchObject({added: 1, aboutMe: 1});
      expect(readFileSync(join(workspaceDir(bot.id), 'MEMORY.md'), 'utf8')).toContain('The person prefers tea.');
      expect(aboutMe).toEqual(['The person prefers tea.']);
    } finally { upkeep.stop(); await upkeep.idle(); await flushMemoryJournal(bot.id); }
  });
  it.each(['abort', 'dispose', 'signOut'] as const)('terminates a pending helper on %s', async action => {
    if (action === 'signOut') {
      vi.spyOn(ChatGptPlanAuthController.prototype, 'models').mockResolvedValue({default: 'plan-model', options: [{id: 'plan-model', label: 'Fixture'}]});
      vi.spyOn(ChatGptPlanAuthController.prototype, 'accessToken').mockResolvedValue('synthetic-plan-token');
      vi.spyOn(ChatGptPlanAuthController.prototype, 'signOut').mockResolvedValue();
    }
    const engine = await create('background-text-hang', {}, action === 'signOut' ? {authMode: 'chatgpt-plan'} : {});
    const controller = new AbortController();
    const started = waitForTurn();
    const result = engine.generateText!('Wait', {signal: controller.signal});
    const rejected = expect(result).rejects.toThrow(/aborted/);
    await started;
    if (action === 'abort') controller.abort(); else if (action === 'signOut') await engine.signOut!(); else await engine.dispose();
    await rejected;
  });
});
