// Live two-way GitHub issue sync against a real, disposable repository. Skipped unless both are set:
//   ORIGIN_LIVE_GITHUB_REPO=owner/repo ORIGIN_LIVE_GITHUB_TOKEN=<token with repo scope> npm run e2e -- --grep "github live"
// It drives the real path: the project token is saved through /api/github/connection, Origin edits queue the issue,
// and the signed /api/integrations/tick worker pushes and pulls through GitHub's REST API. Nothing is mocked.
import { createHmac } from 'node:crypto';
import { test, expect, local } from '../support/fixtures.mjs';

const repo = process.env.ORIGIN_LIVE_GITHUB_REPO;
const token = process.env.ORIGIN_LIVE_GITHUB_TOKEN;

async function gh(path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path}: ${response.status}`);
  return response.json();
}
/** The signed worker call Convex makes; issues:true drains the outbox, {} also runs the 2-minute reconcile. */
async function tick(body = {}) {
  const raw = JSON.stringify({ at: Date.now(), ...body });
  const signature = createHmac('sha256', process.env.ORIGIN_INTEGRATION_SECRET).update(raw).digest('hex');
  const response = await fetch(`${process.env.ORIGIN_E2E_APP_URL}/api/integrations/tick`, { method: 'POST', body: raw, headers: { 'x-origin-signature': signature } });
  expect(response.status, await response.text()).toBeLessThan(300);
}
async function until(read, check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (check(last)) return last;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Timed out: ${label}. Last: ${JSON.stringify(last)?.slice(0, 400)}`);
}
// GitHub reuses an existing label whatever its case (Origin's Bug lands on the repo's default bug).
const names = issue => issue.labels.map(label => label.name.toLowerCase()).sort();

test('github live two-way issue sync', async ({ f }) => {
  test.skip(!repo || !token, 'Set ORIGIN_LIVE_GITHUB_REPO and ORIGIN_LIVE_GITHUB_TOKEN');
  test.setTimeout(420000);
  const log = (...line) => console.log('[github-live]', ...line);
  const projectId = await f.owner.api.m('projects:create', { teamId: f.teamId, name: `Sync ${f.id}`, repoUrl: `https://github.com/${repo}` });
  await local(f.owner, `/api/github/connection?projectId=${projectId}`, { token });
  const board = await f.owner.api.q('tasks:board', { projectId });
  const backlog = board.columns.find(column => column.isDraft) ?? board.columns[0];
  const todo = board.columns.find(column => column._id !== backlog._id && !column.isDone);
  const details = taskId => f.owner.api.q('tasks:details', { projectId, taskId });

  // 1. A Backlog issue stays in Origin.
  const taskId = await f.owner.api.m('tasks:createTask', { projectId, columnId: backlog._id, title: `Live sync ${f.id}`, description: 'Created in Backlog.', priority: 'medium' });
  await tick({ issues: true });
  await new Promise(r => setTimeout(r, 4000));
  expect((await details(taskId)).task.githubIssueUrl).toBeFalsy();
  log('backlog issue not mirrored: ok');

  // 2. Moving it out of Backlog creates exactly one GitHub issue.
  await f.owner.api.m('tasks:moveTask', { projectId, taskId, columnId: todo._id });
  const linked = await until(async () => { await tick({ issues: true }); return (await details(taskId)).task; }, task => Boolean(task.githubIssueUrl), 'GitHub issue created');
  const number = Number(linked.githubIssueUrl.split('/').pop());
  log('created', linked.githubIssueUrl);
  let issue = await gh(`/issues/${number}`);
  expect(issue.title).toBe(`Live sync ${f.id}`);
  expect(issue.body).toContain(`origin-task:${taskId}`);
  await tick({ issues: true });
  // GitHub's issue list lags a fresh create by a few seconds; wait for it, then count.
  const mine = await until(() => gh(`/issues?state=all&per_page=100`).then(list => list.filter(item => item.body?.includes(`origin-task:${taskId}`))), list => list.length > 0, 'issue listed');
  expect(mine).toHaveLength(1);
  log('idempotent: one GitHub issue');

  // 3. Origin → GitHub: title, body, labels.
  await f.owner.api.m('tasks:updateTask', { projectId, taskId, title: `Live sync ${f.id} (edited in Origin)`, description: 'Body edited in Origin.' });
  await f.owner.api.m('issueRelations:labels', { taskId, labels: ['Bug'] });
  issue = await until(async () => { await tick({ issues: true }); return gh(`/issues/${number}`); }, value => value.title.endsWith('(edited in Origin)') && value.body.includes('Body edited in Origin.') && names(value).includes('bug'), 'outbound edit');
  log('outbound title/body/labels: ok', names(issue));

  // 4. GitHub → Origin: title, body, labels (picked up by the reconcile pass, as a webhook would).
  await gh(`/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ title: `Live sync ${f.id} (edited on GitHub)`, body: `${issue.body.replace('Body edited in Origin.', 'Body edited on GitHub.')}`, labels: ['Bug', 'Feature'] }) });
  const inbound = await until(async () => { await tick(); return (await details(taskId)).task; }, task => task.title.endsWith('(edited on GitHub)') && (task.description || '').includes('Body edited on GitHub.') && (task.labels || []).some(label => label.toLowerCase() === 'feature'), 'inbound edit', 150000);
  expect(inbound.description).not.toContain('origin-task:');
  log('inbound title/body/labels: ok', inbound.labels);

  // 5. Complete closes, reopen reopens.
  await f.owner.api.m('tasks:updateTask', { projectId, taskId, done: true });
  await until(async () => { await tick({ issues: true }); return gh(`/issues/${number}`); }, value => value.state === 'closed', 'closed on complete');
  log('complete → closed: ok');
  await f.owner.api.m('tasks:updateTask', { projectId, taskId, done: false });
  await until(async () => { await tick({ issues: true }); return gh(`/issues/${number}`); }, value => value.state === 'open', 'reopened on reopen');
  log('reopen → open: ok');

  // 6. Delete in Origin closes the GitHub issue (not planned).
  await f.owner.api.m('tasks:deleteTask', { projectId, taskId });
  const closed = await until(async () => { await tick({ issues: true }); return gh(`/issues/${number}`); }, value => value.state === 'closed', 'closed on delete');
  log('delete → closed:', closed.state_reason);
  console.log(`[github-live] RESULT repo=${repo} issue=#${number} url=${linked.githubIssueUrl}`);
});
