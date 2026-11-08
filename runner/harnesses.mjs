import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ManagedProcess, JsonRpc, jsonLines, ompJsonLines } from './process.mjs';
import { accountEnvironment, codexQuota, codexIdentity, identityHash } from './accounts.mjs';
import { RunError, classifyFailure } from './security.mjs';
import { UsageTotals, claudeUsage } from './usage.mjs';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); return { promise, resolve, reject }; }
function nativeError(error) { return Object.assign(new RunError(classifyFailure(error), error?.message ?? 'Native harness failed'), { httpStatus: error?.httpStatus ?? error?.api_error_status }); }
function attach(process, context) {
  const done = deferred();
  process.child.stderr.setEncoding('utf8');
  process.child.stderr.on('data', text => context.output('stderr', text));
  process.exit.then(result => done.reject(context.signal.aborted ? context.signal.reason : result.error ?? new RunError('failed', `Harness exited before terminal protocol receipt (${result.code ?? result.signal})`)));
  return done;
}
export function harnessArguments(harness, selection, permissionMode, sessionDirectory) {
  const effort = selection.effort ? ['--thinking', selection.effort] : [];
  if (harness === 'omp') return ['--mode', 'rpc-ui', '--no-ui', '--no-prewalk', '--no-extensions', '--model', selection.model, '--models', selection.model, '--smol', selection.model, '--slow', selection.model, '--plan', selection.model, '--session-dir', sessionDirectory, '--approval-mode', permissionMode === 'ask' ? 'always-ask' : 'write', ...effort];
  if (harness === 'pi') return ['--mode', 'rpc', '--no-extensions', '--no-mcp', '--no-approve', '--model', selection.model, '--models', selection.model, '--session-dir', sessionDirectory, ...effort];
  if (harness === 'claude-code') return ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', selection.model, '--permission-mode', permissionMode === 'ask' ? 'manual' : 'acceptEdits', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(selection.effort ? ['--effort', selection.effort] : [])];
  if (harness === 'codex') return ['app-server', '--listen', 'stdio://'];
  throw new RunError('failed', 'Unsupported automated harness');
}
export async function startHarness(context) {
  const { run, account, cwd, sessionDirectory, signal } = context;
  const harness = run.selection.harness;
  if (harness === 't3') throw new RunError('needs_approval', `T3 requires a supported pinned server and authenticated API with exact account/model/effort plus stop receipts. Open ${cwd} as a project in T3 and explicitly choose the selected account/model; Origin has not started a T3 model.`);
  let permissionServer;
  // Project variables, especially provider API keys, must not select native CLI auth.
  const env = accountEnvironment(account.binding);
  if (context.projectEnvironmentFile) {
    env.ORIGIN_PROJECT_ENV_FILE = context.projectEnvironmentFile;
    env.ORIGIN_PROJECT_ENV_RUNNER = fileURLToPath(new URL('./project-env.mjs', import.meta.url));
    env.ORIGIN_PROJECT_NODE = globalThis.process.execPath;
  }
  const args = harnessArguments(harness, run.selection, run.permissionMode, sessionDirectory);
  if (['omp', 'pi'].includes(harness) && account.binding.provider) args.push('--provider', account.binding.provider);
  if (harness === 'pi' && run.permissionMode === 'ask') {
    permissionServer = await servePermissions(context);
    env.ORIGIN_PERMISSION_ENDPOINT = permissionServer.endpoint;
    env.ORIGIN_PERMISSION_TOKEN = permissionServer.token;
    context.addSecret?.(permissionServer.token);
    args.push('--extension', fileURLToPath(new URL('./pi-permissions.mjs', import.meta.url)));
  }
  if (harness === 'claude-code') { env.CLAUDE_CODE_SDK_READS_SESSION_STATE = '1'; env.DISABLE_AUTOUPDATER = '1'; }
  const process = new ManagedProcess(account.binding.executable, args, { cwd, env, signal });
  if (harness === 'omp' || harness === 'pi') process.beforeStop = () => process.send({ type: 'abort', id: 'origin-stop' });
  if (harness === 'claude-code') process.beforeStop = () => process.send({ type: 'control_request', request_id: 'origin-stop', request: { subtype: 'interrupt' } });
  const done = attach(process, context);
  const handle = { done: done.promise, process, stop: async () => { await process.stop(); await permissionServer?.close(); }, message: async () => { throw new Error('Harness not initialized'); } };
  try {
    if (harness === 'codex') await startCodex(process, done, handle, context);
    else if (harness === 'claude-code') await startClaude(process, done, handle, context);
    else await startPiFamily(process, done, handle, context);
    return handle;
  } catch (error) { await handle.stop(); throw error; }
}
async function startCodex(process, done, handle, context) {
  let threadId, turnId;
  const { run } = context;
  const rpc = new JsonRpc(process, frame => {
    const data = frame.params ?? {};
    if (frame.method === 'turn/started') turnId = data.turn.id;
    if (frame.method === 'item/agentMessage/delta' || frame.method === 'item/commandExecution/outputDelta') context.output('stdout', data.delta ?? '');
    if (frame.method === 'thread/tokenUsage/updated') {
      const usage = data.tokenUsage?.total;
      if (usage) context.usage({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
    if (frame.method === 'account/rateLimits/updated') context.usage({ quota: codexQuota(data) });
    if (frame.method === 'turn/completed') {
      if (data.turn.status === 'completed') done.resolve({ summary: 'Codex turn completed' });
      else if (data.turn.status === 'interrupted') done.reject(new RunError('cancelled', 'Codex turn interrupted'));
      else done.reject(nativeError(data.turn.error));
    }
  }, async frame => {
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(frame.method)) {
      const allowed = await context.approve(frame.method, frame.params);
      return { decision: allowed ? 'accept' : 'decline' };
    }
    if (frame.method === 'item/permissions/requestApproval') {
      const allowed = await context.approve(frame.method, frame.params);
      return { permissions: allowed ? frame.params.permissions : {}, scope: 'turn' };
    }
    // Never return a token for account/chatgptAuthTokens/refresh; native CLI owns auth.
    done.reject(new RunError('needs_approval', `Native request requires an unsupported interactive response: ${frame.method}`));
    throw new Error('Unsupported interactive response');
  });
  await rpc.initialize();
  const current = codexIdentity(await rpc.call('account/read', { refreshToken: false }), context.account.binding);
  if (!current) throw new RunError('needs_auth', 'Codex account workspace identity could not be verified');
  const fingerprint = context.account.binding.identityHash ?? identityHash('openai', current);
  if (fingerprint !== context.account.report.identityHash) throw new RunError('needs_auth', 'Codex account changed before the turn started');
  const { thread } = await rpc.call('thread/start', { model: run.selection.model, cwd: context.cwd, approvalPolicy: run.permissionMode === 'ask' ? 'untrusted' : 'on-request', sandbox: 'workspace-write', serviceName: 'origin-runner' });
  threadId = thread.id;
  const { turn } = await rpc.call('turn/start', { threadId, input: [{ type: 'text', text: context.prompt }], model: run.selection.model, ...(run.selection.effort ? { effort: run.selection.effort } : {}) });
  turnId = turn.id;
  process.beforeStop = () => rpc.call('turn/interrupt', { threadId, turnId }, 500);
  handle.message = text => rpc.call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
}
async function startClaude(process, done, handle, context) {
  const init = deferred();
  let lastResult, providerError, state, activeTasks = new Set();
  const totals = new UsageTotals();
  const settle = () => {
    if (!lastResult || activeTasks.size || state === 'running') return;
    if (lastResult.is_error) done.reject(nativeError({ code: providerError, message: lastResult.errors?.join('; ') || lastResult.result || lastResult.subtype, api_error_status: lastResult.api_error_status }));
    else done.resolve({ summary: lastResult.result ?? 'Claude Code turn completed' });
  };
  jsonLines(process.child.stdout, frame => {
    if (frame.type === 'control_response' && frame.response?.request_id === 'origin-init') {
      if (frame.response.subtype === 'error') init.reject(new Error(frame.response.error)); else init.resolve(frame.response.response);
    }
    if (frame.type === 'control_request') {
      const request = frame.request;
      if (request.subtype !== 'can_use_tool') {
        process.send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Unsupported interactive request' } }).catch(done.reject);
        done.reject(new RunError('needs_approval', `Claude requires interactive ${request.subtype}`));
        return;
      }
      context.approve(request.tool_name, request.input).then(allow => process.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: allow ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Denied by Origin task owner', interrupt: true } } })).catch(done.reject);
    }
    if (frame.type === 'assistant') {
      providerError = typeof frame.error === 'string' ? frame.error : undefined;
      for (const part of frame.message?.content ?? []) if (part.type === 'text') context.output('stdout', `${part.text}\n`);
    }
    if (frame.type === 'system' && frame.subtype === 'session_state_changed') { state = frame.state; settle(); }
    if (frame.type === 'system' && frame.subtype === 'task_started' && ['local_agent', 'local_workflow'].includes(frame.task_type)) activeTasks.add(frame.task_id);
    if (frame.type === 'system' && frame.subtype === 'task_notification') { activeTasks.delete(frame.task_id); settle(); }
    if (frame.type === 'rate_limit_event') {
      const info = frame.rate_limit_info;
      // This event supplies status/reset, not necessarily percentages. Never invent quota windows.
      if (info?.status === 'rejected') done.reject(new RunError('quota', 'Claude native rate-limit event rejected further usage'));
    }
    if (frame.type === 'result') {
      lastResult = frame;
      context.usage(claudeUsage(totals, frame, context.account.report.authKind === 'api'));
      if (frame.permission_denials?.length) done.reject(new RunError('needs_approval', 'Claude reported denied tool permissions'));
      settle();
    }
  }, error => { init.reject(error); done.reject(error); });
  const timer = setTimeout(() => init.reject(new Error('Claude initialize timed out')), 30000);
  try { await process.send({ type: 'control_request', request_id: 'origin-init', request: { subtype: 'initialize' } }); await init.promise; }
  finally { clearTimeout(timer); }
  handle.message = text => process.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', client_composed: true });
  await handle.message(context.prompt);
}
async function startPiFamily(process, done, handle, context) {
  const omp = context.run.selection.harness === 'omp';
  let terminal, providerError;
  const totals = new UsageTotals();
  const ready = deferred();
  const receive = frame => {
    if (frame.type === 'response' && frame.success === false) done.reject(new RunError('failed', frame.error ?? 'Native RPC command rejected'));
    if (frame.type === 'response' && frame.id === 'origin-state' && frame.success) ready.resolve(frame.data);
    if (frame.type === 'message_update') {
      const event = frame.assistantMessageEvent;
      if (event?.type === 'text_delta') context.output('stdout', event.delta);
    }
    if (frame.type === 'message_end') {
      const message = frame.message;
      if (message?.stopReason === 'error') providerError = { message: message.errorMessage, httpStatus: message.httpStatus };
      if (message?.usage) context.usage(totals.add({ inputTokens: (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0), outputTokens: message.usage.output, ...(context.account.report.authKind === 'api' ? { estimatedApiUsd: message.usage.cost?.total } : {}) }));
    }
    if (frame.type === 'extension_ui_request') {
      if (frame.method === 'confirm') context.approve(frame.title ?? 'Tool permission', { message: frame.message }).then(confirmed => process.send({ type: 'extension_ui_response', id: frame.id, confirmed })).catch(done.reject);
      else if (omp && frame.method === 'select' && frame.options?.includes('Deny') && frame.options.some(value => value === 'Approve' || value === 'Approve Once')) {
        const once = frame.options.includes('Approve Once') ? 'Approve Once' : 'Approve';
        context.approve(frame.title ?? 'Tool permission', { options: [once, 'Deny'] }).then(allow => process.send({ type: 'extension_ui_response', id: frame.id, value: allow ? once : 'Deny' })).catch(done.reject);
      }
      else if (['select', 'input', 'editor', 'ask'].includes(frame.method)) {
        process.send({ type: 'extension_ui_response', id: frame.id, cancelled: true }).catch(done.reject);
        done.reject(new RunError('needs_approval', `Harness requires interactive ${frame.method}; send a task message with the required answer`));
      }
    }
    if (omp && frame.type === 'prompt_result') {
      terminal = frame;
      if (frame.status === 'error') done.reject(nativeError({ ...providerError, ...frame.error }));
      else if (frame.status === 'aborted') done.reject(new RunError('cancelled', 'OMP prompt aborted'));
      else if (frame.sessionSettled) done.resolve({ summary: 'OMP prompt and background work completed' });
    }
    if (omp && frame.type === 'session_settled' && terminal?.status === 'completed') done.resolve({ summary: 'OMP session settled' });
    if (!omp && frame.type === 'agent_settled') {
      if (providerError) done.reject(nativeError(providerError)); else done.resolve({ summary: 'Pi session settled' });
    }
  };
  if (omp) await ompJsonLines(process, receive, done.reject);
  else jsonLines(process.child.stdout, receive, done.reject);
  await process.send({ type: 'get_state', id: 'origin-state' });
  const state = await Promise.race([ready.promise, done.promise]);
  const provider = context.account.binding.provider;
  const requested = context.run.selection.model;
  const modelId = provider && requested.startsWith(`${provider}/`) ? requested.slice(provider.length + 1) : requested;
  if (!state?.model || state.model.id !== modelId || (provider && state.model.provider !== provider)) throw new RunError('needs_auth', 'Native harness resolved a different provider/model than the explicitly selected account');
  if (context.run.selection.effort && state.thinkingLevel !== context.run.selection.effort) throw new RunError('failed', 'Native harness did not honor the explicitly selected effort');
  handle.message = message => process.send({ type: 'steer', id: randomUUID(), message });
  await process.send({ type: 'prompt', id: 'origin-prompt', message: context.prompt });
}
async function servePermissions(context) {
  const token = randomUUID();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/approve' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Permission request too large'); }
      const event = JSON.parse(body);
      const allow = await context.approve(event.toolName, event.input);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ allow }));
    } catch { response.writeHead(503).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { token, endpoint: `http://127.0.0.1:${server.address().port}/approve`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
