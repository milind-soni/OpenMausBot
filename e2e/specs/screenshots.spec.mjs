// Screenshots of the Linear-polish rounds: ORIGIN_SHOTS_DIR=/tmp/shots npm run e2e -- --grep "polish screenshots".
// With ORIGIN_LINEAR_REFS=/path/to/linear-refs it also composes Origin | Linear side-by-sides (compare-*.png).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../support/fixtures.mjs';

// Only with ORIGIN_SHOTS_DIR=/path: it writes PNGs and seeds a pull request with `convex import` on the local backend.
const shots = process.env.ORIGIN_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const shot = (target, name, options = {}) => target.screenshot({ path: resolve(shots, name), animations: 'disabled', ...options });
const refs = process.env.ORIGIN_LINEAR_REFS;
/** Origin's shot on the left, the official Linear reference on the right, at the same height. */
async function compare(page, name, origin, linear, caption) {
  if (!refs || !existsSync(resolve(refs, linear))) return;
  const data = file => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  await page.setViewportSize({ width: 1600, height: 640 });
  await page.setContent(`<style>body{margin:0;background:#08090a;color:#9a9ba2;font:13px Inter,system-ui,sans-serif}main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}figure{margin:0;display:grid;gap:8px}img{width:100%;height:560px;object-fit:contain;object-position:left top;border:1px solid #26272b;border-radius:8px;background:#0e0f11}</style>
    <main><figure><img src="${data(resolve(shots, origin))}"><figcaption>Origin · ${caption}</figcaption></figure><figure><img src="${data(resolve(refs, linear))}"><figcaption>Linear (official docs) · ${linear}</figcaption></figure></main>`);
  await page.screenshot({ path: resolve(shots, name) });
}
const day = offset => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };

test('polish screenshots', async ({ clients, f }) => {
  test.skip(!shots, 'Set ORIGIN_SHOTS_DIR to capture screenshots');
  test.setTimeout(180000);
  const [backlog, todo, progress] = f.board.columns;
  const make = async (person, column, title, extra = {}) => {
    const { labels, estimate, ...rest } = extra;
    const taskId = await person.api.m('tasks:createTask', { ...f.project, columnId: column._id, title, priority: 'medium', ...rest });
    if (labels) await person.api.m('issueRelations:labels', { taskId, labels });
    if (estimate) await person.api.m('tasks:updateTask', { ...f.project, taskId, estimate });
    return taskId;
  };
  await make(f.member, backlog, 'Offline mode for the desktop app');
  await make(f.member, backlog, 'Explore a calendar view for due dates', { priority: 'low', labels: ['Feature'], description: 'Week and month views.' });
  const login = await make(f.member, todo, 'Login button misaligned on Safari', { priority: 'high', labels: ['Bug'], estimate: 2, assignedToEmail: f.member.email, dueDate: day(1) });
  await make(f.member, todo, 'Add CSV export for issues', { labels: ['Feature'], estimate: 5, assignedToEmail: f.admin.email });
  await make(f.member, todo, 'Keyboard shortcut cheat sheet', { priority: 'low', labels: ['Feature', 'Design'], estimate: 2 });
  await make(f.member, progress, 'Speed up board drag on large projects', { labels: ['Improvement'], estimate: 3, assignedToEmail: f.admin.email, dueDate: day(6) });
  const crash = await make(f.member, progress, 'Crash when pasting images into comments', { priority: 'high', labels: ['Bug'], estimate: 1, assignedToEmail: f.member.email, dueDate: day(-2), description: 'Pasting a PNG from the clipboard into a comment closes the tab on Chrome 131.' });
  await f.member.api.m('tasks:addComment', { ...f.project, taskId: crash, body: 'Reproduced on Chrome and Arc. Firefox is fine.' }).catch(() => undefined);

  const done = await make(f.member, todo, 'Draft the release notes for 0.9', { labels: ['Improvement'], estimate: 1 });
  await f.member.api.m('tasks:updateTask', { ...f.project, taskId: done, done: true });

  const page = await clients.login(f.admin, f.url());
  const card = title => page.locator('.task-card').filter({ hasText: title });
  await expect(card('Login button misaligned on Safari')).toBeVisible();
  await page.mouse.move(1, 1);
  // Board in the Active view (the default): no Backlog column, no completed issues.
  await expect(page.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, 'board.png');
  await shot(page, 'nav-sidebar.png', { clip: { x: 0, y: 0, width: 520, height: 330 } });
  await shot(page.locator('.project-navigation'), 'nav-issues.png');
  await shot(page, 'view-tabs.png', { clip: { x: 240, y: 0, width: 1200, height: 112 } });

  // Hover and a card close-up.
  await card('Crash when pasting images into comments').hover();
  await shot(page.locator('[data-column-title="In progress"]'), 'cards-hover.png');
  await shot(card('Login button misaligned on Safari'), 'card-labels.png');

  // Display popover.
  await page.mouse.move(1, 1);
  await page.keyboard.press('Shift+V');
  await expect(page.getByRole('dialog', { name: 'Display options' })).toBeVisible();
  await shot(page, 'display-popover.png', { clip: { x: 840, y: 0, width: 600, height: 620 } });
  await page.keyboard.press('Escape');

  // Filter bar: a label filter and an assignee filter as formula chips.
  await page.keyboard.press('f');
  await page.getByRole('menuitem', { name: /^Labels/ }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Bug' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Feature' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: /^Priority/ }).click();
  await page.getByRole('menuitemcheckbox', { name: 'High' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.filter-chip')).toHaveCount(2);
  await page.mouse.move(1, 1);
  await shot(page, 'filter-bar.png', { clip: { x: 240, y: 0, width: 1200, height: 420 } });
  await page.getByRole('button', { name: 'Clear', exact: true }).click();

  // Label picker from the card's labels.
  await card('Keyboard shortcut cheat sheet').locator('.label-chips-button').click();
  await expect(page.locator('.label-picker-popover')).toBeVisible();
  await shot(page, 'label-picker.png');
  await page.keyboard.press('Escape');

  // Card menu with the estimate submenu.
  await card('Add CSV export for issues').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Estimate/ }).click();
  await shot(page, 'card-menu-estimate.png');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Backlog and All issues.
  await page.getByRole('tab', { name: 'Backlog' }).click();
  await page.mouse.move(1, 1);
  await shot(page, 'board-backlog.png');
  await page.getByRole('tab', { name: 'All issues' }).click();
  await expect(card('Draft the release notes for 0.9')).toBeVisible();
  await page.mouse.move(1, 1);
  await shot(page, 'board-all.png');

  // List view (All issues: completed rows last in their group).
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.issue-table')).toBeVisible();
  await page.mouse.move(1, 1);
  await shot(page, 'list.png');
  await page.getByRole('tab', { name: 'Active' }).click();
  await page.mouse.move(1, 1);
  await shot(page, 'list-active.png');
  await page.getByRole('button', { name: 'Board view' }).click();

  // Completed issues (the quiet archive beside the tabs).
  await page.getByRole('button', { name: 'Completed issues', exact: true }).click();
  await expect(page.locator('.archive-row')).toHaveCount(1);
  await page.mouse.move(1, 1);
  await shot(page, 'completed.png');
  await page.getByRole('button', { name: 'Completed issues', exact: true }).click();

  // Command palette and shortcuts.
  await card('Login button misaligned on Safari').focus();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command menu' })).toBeVisible();
  await shot(page, 'command-palette.png');
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 500 } });
  await page.keyboard.press('?');
  await expect(page.locator('.shortcuts-sheet')).toBeVisible();
  await shot(page, 'shortcuts.png');
  await page.keyboard.press('Escape');

  // Issue page.
  const key = `ORI-${String(crash).slice(-4).toUpperCase()}`;
  await page.goto(`/${f.workspace.slug}/issue/${key}/${crash}`);
  await expect(page.locator('[data-issue-page]')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, 'issue-page.png');
  await page.goto(`/${f.workspace.slug}/issue/ORI-${String(login).slice(-4).toUpperCase()}/${login}`);
  await expect(page.locator('[data-issue-page]')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'issue-page-labels.png');

  // Code tab without a repository (old ?tab=repo link).
  await page.goto(f.url('tab=repo'));
  await expect(page.getByRole('tab', { name: 'Code' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/tab=code/);
  await page.mouse.move(1, 1);
  await shot(page, 'code-empty.png');

  // Inbox.
  await page.getByRole('button', { name: /^Inbox/ }).first().click();
  await page.waitForTimeout(600);
  await shot(page, 'inbox.png');

  // Code tab with a repository: a linked pull request (seeded locally) and the repository snapshot (mocked).
  const repoUrl = 'https://github.com/acme/origin-demo';
  const gamma = await f.owner.api.m('projects:create', { teamId: f.teamId, name: `Origin demo ${f.id}`, repoUrl });
  const gammaBoard = await f.owner.api.q('tasks:board', { projectId: gamma });
  const fix = await f.owner.api.m('tasks:createTask', { projectId: gamma, columnId: gammaBoard.columns[1]._id, title: 'Fix login redirect loop', priority: 'high' });
  const fixKey = `ORI-${String(fix).slice(-4).toUpperCase()}`;
  const now = Date.now();
  const rows = [
    { projectId: gamma, taskId: fix, requesterUserId: f.owner.user.id || f.owner.user._id, number: 42, url: `${repoUrl}/pull/42`, branch: `${fixKey.toLowerCase()}-fix-login-redirect`, state: 'open', checks: 'success', review: 'approved', mergeable: true, repository: 'acme/origin-demo', title: 'Fix login redirect loop', authorLogin: 'sam', linkSource: 'reference', updatedAt: now - 3600000 },
  ];
  const file = resolve(shots, '.seed-prs.jsonl');
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
  let seeded = true;
  try { execFileSync('npx', ['convex', 'import', '--table', 'taskPullRequests', '--append', '-y', file], { stdio: 'pipe', timeout: 60000 }); }
  catch (error) { seeded = false; console.warn('PR seed skipped:', String(error.stderr || error).slice(0, 300)); }
  const snapshot = {
    repo: 'acme/origin-demo', tokenConfigured: true, commitsError: '', hosted: 'origin-local',
    commits: [
      { sha: 'a1b2c3d4e5f6a7b8c9d0', message: 'Fix login redirect loop', author: 'sam', url: `${repoUrl}/commit/a1b2c3d`, committedAt: now - 3600000 },
      { sha: 'b2c3d4e5f6a7b8c9d0e1', message: 'Tighten board card spacing', author: 'alex', url: `${repoUrl}/commit/b2c3d4e`, committedAt: now - 86400000 },
      { sha: 'c3d4e5f6a7b8c9d0e1f2', message: 'Add estimates to issues', author: 'alex', url: `${repoUrl}/commit/c3d4e5f`, committedAt: now - 2 * 86400000 },
    ],
    issues: [{ number: 12, title: 'Docs: self-hosting guide is out of date', state: 'open', url: `${repoUrl}/issues/12`, author: 'kim', updatedAt: now - 7200000 }],
    pullRequests: [
      { number: 42, title: 'Fix login redirect loop', state: 'open', url: `${repoUrl}/pull/42`, author: 'sam', branch: `${fixKey.toLowerCase()}-fix-login-redirect`, updatedAt: now - 3600000 },
      { number: 41, title: 'Bump convex to 1.37', state: 'open', url: `${repoUrl}/pull/41`, author: 'renovate', branch: 'renovate/convex-1.x', updatedAt: now - 5 * 3600000 },
      { number: 39, title: 'Add estimates to issues', state: 'merged', url: `${repoUrl}/pull/39`, author: 'alex', branch: 'estimates', updatedAt: now - 2 * 86400000 },
    ],
  };
  const owner = await clients.login(f.owner, `/${f.workspace.slug}?project=${gamma}`);
  await owner.route('**/api/github/repo?**', route => route.fulfill({ json: snapshot }));
  await owner.getByRole('tab', { name: 'Code' }).click();
  await expect(owner.locator('.code-row').first()).toBeVisible();
  if (seeded) await expect(owner.locator('.pull-request-issue')).toBeVisible();
  await owner.mouse.move(1, 1);
  await shot(owner, 'code.png');
  await shot(owner.locator('.project-navigation'), 'nav-code.png');
  await owner.getByRole('tab', { name: /Commits/ }).click();
  await shot(owner, 'code-commits.png');
  await owner.locator('.project-tab[data-tab="assets"]').hover();
  await shot(owner.locator('.project-navigation'), 'nav-hover.png');
  await owner.locator('.project-tab[data-tab="vault"]').focus();
  await owner.keyboard.press('ArrowRight');
  await shot(owner.locator('.project-navigation'), 'nav-focus.png');

  // Phone width: the pills fold to icons beside the open one; the view tabs stay on one row with the actions.
  const phone = await clients.login(f.admin, f.url(), { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await expect(phone.locator('.task-card').first()).toBeVisible();
  await shot(phone, 'phone-board.png');
  await phone.getByRole('button', { name: 'Open navigation' }).click();
  await phone.waitForTimeout(400);
  await shot(phone, 'phone-nav.png');

  // Origin | Linear side-by-sides from the official docs images.
  const sheet = await clients.login(f.admin, f.url());
  await compare(sheet, 'compare-sidebar.png', 'nav-sidebar.png', 'docs-team-pages.png', 'sidebar');
  await compare(sheet, 'compare-view-tabs.png', 'view-tabs.png', 'docs-filters.png', 'view tabs + header');
  await compare(sheet, 'compare-display.png', 'display-popover.png', 'docs-display-options.png', 'Display popover');
  await compare(sheet, 'compare-filter-bar.png', 'filter-bar.png', 'docs-filters.png', 'filter bar');
  await compare(sheet, 'compare-header.png', 'view-tabs.png', 'docs-custom-views-board.png', 'header cluster');
  await compare(sheet, 'compare-board.png', 'board.png', 'docs-board-layout.png', 'board');
  await compare(sheet, 'compare-list.png', 'list-active.png', 'docs-filters.png', 'list');
});
