// O-130: an MCP client adds Origin by URL alone, the way Claude.ai, ChatGPT and Claude Code connectors do:
// 401 + RFC 9728 discovery → RFC 8414 metadata → RFC 7591 registration → PKCE consent in the browser → token →
// tools over Streamable HTTP. Then an agent takes a delegated issue and reports in its Activity, and the read-only
// endpoint serves read tools only. Screenshots with ORIGIN_SHOTS_DIR.
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { test, expect } from '../support/fixtures.mjs';

const shots = process.env.ORIGIN_SHOTS_DIR;
const shot = (target, name, options = {}) => shots ? target.screenshot({ path: resolve(shots, name), animations: 'disabled', ...options }) : undefined;
const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function mcp(url, token) {
  const client = new Client({ name: 'o130', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const result = response => JSON.parse(response.content[0].text);

test('O-130 MCP connector: discovery, DCR, PKCE consent, tools, delegation and read-only endpoint', async ({ clients, f }) => {
  test.setTimeout(180000);
  const app = process.env.ORIGIN_E2E_APP_URL, endpoint = `${app}/api/mcp`;

  // 1. Unauthenticated request → 401 pointing at the protected-resource metadata.
  const challenge = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  expect(challenge.status).toBe(401);
  const header = challenge.headers.get('www-authenticate') || '';
  const resourceMetadata = header.match(/resource_metadata="([^"]+)"/)?.[1];
  expect(resourceMetadata, header).toBeTruthy();
  const resource = await (await fetch(resourceMetadata)).json();
  expect(resource.resource).toBe(endpoint);
  const server = await (await fetch(`${resource.authorization_servers[0].replace(/\/$/, '')}/.well-known/oauth-authorization-server`)).json();
  expect(server.code_challenge_methods_supported).toContain('S256');
  console.log('[o130] discovery ok:', { resource: resource.resource, registration: server.registration_endpoint, cimd: server.client_id_metadata_document_supported });

  // 2. Dynamic client registration (a public client, as Claude Code registers).
  const redirect = 'http://127.0.0.1:43123/callback';
  const registered = await fetch(server.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'O-130 connector', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  expect(registered.status).toBe(201);
  const { client_id } = await registered.json();

  // 3. PKCE authorization in the browser: the signed-in owner approves on the consent page.
  const verifier = base64url(randomBytes(32)), challengeValue = base64url(createHash('sha256').update(verifier).digest()), state = base64url(randomBytes(8));
  const authorize = new URL(server.authorization_endpoint);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id, redirect_uri: redirect, code_challenge: challengeValue, code_challenge_method: 'S256', state, resource: endpoint, scope: server.scopes_supported?.join(' ') || '' })) if (value) authorize.searchParams.set(key, value);
  const page = await clients.login(f.owner, f.url());
  let callback = '';
  await page.route('http://127.0.0.1:43123/**', route => { callback = route.request().url(); return route.fulfill({ body: 'ok' }); });
  await page.goto(authorize.toString());
  await expect(page.getByRole('heading', { name: 'Connect O-130 connector' })).toBeVisible();
  await page.mouse.move(1, 1);
  await shot(page, 'mcp-consent.png');
  await page.getByRole('button', { name: /^(Allow|Connect|Approve)/ }).click();
  await expect.poll(() => callback, { timeout: 15000 }).toContain('code=');
  const back = new URL(callback);
  expect(back.searchParams.get('state')).toBe(state);
  const tokens = await (await fetch(server.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id, code_verifier: verifier, resource: endpoint }) })).json();
  expect(tokens.access_token, JSON.stringify(tokens)).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  console.log('[o130] PKCE token ok:', { token_type: tokens.token_type, scope: tokens.scope, expires_in: tokens.expires_in });

  // 4. Tools over Streamable HTTP with the OAuth token.
  const client = await mcp(endpoint, tokens.access_token);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(['get_workspace', 'list_issues', 'delegate_issue', 'add_agent_activity', 'list_agents']));
  expect(result(await client.callTool({ name: 'get_workspace', arguments: {} }))).toBeTruthy();
  console.log('[o130] tools ok:', names.length, 'tools');

  // 5. A PAT-backed agent the owner lists as taking issues is delegated an issue and reports on it.
  const bot = await f.owner.api.m('mcp:createToken', { teamId: f.teamId, name: 'Grok Bot', write: true });
  await f.owner.api.m('issueActivity:setDelegatable', { teamId: f.teamId, grantId: bot.grantId, delegatable: true });
  const [, todo] = f.board.columns;
  const taskId = await f.owner.api.m('tasks:createTask', { ...f.project, columnId: todo._id, title: 'Import CSV from the billing export', priority: 'medium', assignedToEmail: f.owner.email, description: 'Customers want to import their old invoices.' });
  await f.owner.api.m('issueActivity:delegate', { ...f.project, taskId, grantId: bot.grantId });
  const agent = await mcp(endpoint, bot.token);
  expect(result(await agent.callTool({ name: 'get_inbox', arguments: {} })).delegated.map(row => row.id)).toEqual([taskId]);
  await agent.callTool({ name: 'add_agent_activity', arguments: { issueId: taskId, kind: 'acknowledged', body: 'Read it. Refining with the owner before any code.' } });
  await agent.callTool({ name: 'add_agent_activity', arguments: { issueId: taskId, kind: 'question', body: 'CSV only, or XLSX too? Which columns are required?' } });
  const activity = result(await agent.callTool({ name: 'list_issue_activity', arguments: { issueId: taskId } }));
  expect(activity.activity.map(row => row.kind)).toEqual(['delegated', 'acknowledged', 'question']);

  // 6. The issue page shows the agent next to the human assignee and its Activity.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto(`/${f.workspace.slug}/issue/ORI-${String(taskId).slice(-4).toUpperCase()}/${taskId}`);
  await expect(page.locator('[data-issue-page]')).toBeVisible();
  await expect(page.locator('.issue-property[data-field="agent"]')).toContainText('Grok Bot');
  await expect(page.locator('.agent-activity[data-kind="question"]')).toBeVisible();
  await page.mouse.move(1, 1);
  await shot(page, 'issue-delegate.png');

  // 7. Settings → Integrations lists the setup per client.
  await page.goto(f.url());
  await page.getByRole('button', { name: /account menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.locator('[data-section="integrations"]').click();
  await expect(settings.getByRole('tab', { name: 'Claude.ai' })).toBeVisible();
  await shot(page, 'integrations.png');
  await settings.getByRole('tab', { name: 'Hermes' }).click();
  await expect(settings.getByText('auth: oauth')).toBeVisible();
  await shot(page, 'integrations-hermes.png');
  await settings.locator('[data-section="agents"]').click();
  await expect(settings.getByRole('button', { name: 'Takes issues' })).toBeVisible();
  await shot(page, 'agents-settings.png');

  // 8. The read-only endpoint serves read tools only, even for a write-capable token.
  const readonly = await mcp(`${app}/api/mcp/readonly`, bot.token);
  const readNames = (await readonly.listTools()).tools.map(tool => tool.name);
  expect(readNames).toContain('list_issue_activity');
  expect(readNames).not.toContain('delegate_issue');
  expect(readNames).not.toContain('create_issue');
  console.log('[o130] readonly ok:', readNames.length, 'read tools');
  await Promise.all([client.close(), agent.close(), readonly.close()]);
});
