import { test, expect, local } from '../support/fixtures.mjs';

test('O-001 O-003 sign-in, persistent session and logout', async ({ page, f }) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(f.member.email);
  await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(f.member.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.workspace-app')).toBeVisible();
  await page.reload();
  await expect(page.locator('.workspace-app')).toBeVisible();
  await page.getByRole('button', { name: /account menu$/ }).click();
  await page.getByRole('menuitem', { name: /Log out|Sign out/i }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('O-031 O-033 O-034 O-036 O-038 board CRUD and real drag synchronizes two contexts', async ({ clients, f }) => {
  const writer = await clients.login(f.member), observer = await clients.login(f.admin);
  const lane = (page, title) => page.locator(`[data-testid="board-column"][data-column-title="${title}"]`);
  await writer.getByRole('button', { name: 'Add column', exact: true }).click();
  await writer.getByRole('textbox', { name: 'Column name', exact: true }).fill('Review lane');
  await writer.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(lane(observer, 'Review lane')).toBeVisible();
  await writer.getByRole('button', { name: 'Create issue', exact: true }).first().click();
  let dialog = writer.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Issue title', exact: true }).fill('Browser-created task');
  await dialog.getByRole('button', { name: /^Priority/ }).click();
  await writer.getByRole('option', { name: 'Medium', exact: true }).click();
  await dialog.getByRole('button', { name: /^Assignee/ }).click();
  await writer.getByRole('option', { name: /You$/ }).click();
  await dialog.getByRole('button', { name: /^Due date/ }).click();
  await writer.locator('.date-picker-popover').getByRole('button', { name: /^Tomorrow/ }).click();
  await dialog.getByRole('button', { name: 'Create issue', exact: true }).click();
  const card = writer.locator('.task-card').filter({ hasText: 'Browser-created task' });
  await expect(card).toBeVisible();
  await expect(observer.locator('.task-card').filter({ hasText: 'Browser-created task' })).toBeVisible();
  // Empty lanes fold into a strip once the board has issues; open it, then drag the card in.
  const review = lane(writer, 'Review lane');
  if (await review.locator('.lane-strip').count()) await review.locator('.lane-strip').click();
  await card.dragTo(review.locator('.task-list'));
  await expect(review.locator('.task-card')).toContainText('Browser-created task');
  await expect(lane(observer, 'Review lane').locator('.task-card')).toContainText('Browser-created task');
  await writer.waitForTimeout(500);
  await card.click();
  dialog = writer.getByRole('dialog');
  await dialog.getByLabel('Issue title', { exact: true }).fill('Edited browser task');
  await dialog.getByLabel('Issue description', { exact: true }).fill('Persisted from browser');
  await dialog.getByLabel('Issue description', { exact: true }).blur();
  await expect.poll(async () => (await f.member.api.q('tasks:board', f.project)).tasks[0]?.title).toBe('Edited browser task');
  await writer.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await writer.getByRole('button', { name: 'Review lane column options' }).click();
  await writer.getByRole('menuitem', { name: 'Rename' }).click();
  await writer.getByRole('textbox', { name: 'Column name', exact: true }).fill('Reviewed');
  await writer.getByRole('textbox', { name: 'Column name', exact: true }).press('Enter');
  await expect(lane(observer, 'Reviewed')).toBeVisible();
  await writer.getByRole('button', { name: 'Reviewed column options' }).click();
  await writer.getByRole('menuitem', { name: 'Delete column' }).click();
  await writer.getByRole('dialog').getByRole('button', { name: 'Delete column', exact: true }).click();
  await expect(lane(observer, 'Reviewed')).toHaveCount(0);
  await expect(observer.locator('.task-card')).toContainText('Edited browser task');
  const task = (await f.member.api.q('tasks:board', f.project)).tasks[0];
  await writer.getByRole('button', { name: 'Complete Edited browser task', exact: true }).click();
  await expect(observer.locator('.task-card')).toHaveCount(0);
  expect((await f.member.api.q('tasks:board', f.project)).tasks[0].columnId).toBe(task.columnId);
  await f.member.api.m('tasks:updateTask', { ...f.project, taskId: task._id, done: false });
  await expect(observer.locator('.task-card')).toContainText('Edited browser task');
  await writer.locator('.task-card').filter({ hasText: 'Edited browser task' }).click({ button: 'right' });
  await writer.getByRole('menuitem', { name: 'Delete issue', exact: true }).click();
  await writer.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(observer.locator('.task-card')).toHaveCount(0);
});

test('O-041 O-046 O-053 O-054 comments, assignment, notifications and inbox', async ({ clients, f }) => {
  const target = await clients.login(f.member, `/${f.workspace.slug}?view=inbox`);
  const taskId = await f.admin.api.m('tasks:createTask', { ...f.project, columnId: f.board.columns[0]._id, title: 'Inbox regression', priority: 'high', assignedToEmail: f.member.email, dueDate: '2026-12-31' });
  const writer = await clients.login(f.admin, f.url(`issue=${taskId}`));
  await writer.getByLabel('Comment', { exact: true }).fill('Teammate comment from browser');
  await writer.getByRole('button', { name: 'Send comment' }).click();
  await expect(writer.getByText('Teammate comment from browser', { exact: true })).toBeVisible();
  await expect(target.getByText('Inbox regression', { exact: true }).first()).toBeVisible();
  const notifications = () => f.member.api.q('notifications:list', { teamId: f.teamId, unreadOnly: true, paginationOpts: { numItems: 50, cursor: null } });
  await expect.poll(async () => (await notifications()).page.length).toBeGreaterThanOrEqual(2);
  const note = (await notifications()).page[0];
  await f.member.api.m('notifications:markRead', { teamId: f.teamId, id: note._id, read: true });
  expect((await notifications()).page.some(n => n._id === note._id)).toBe(false);
  await f.member.api.m('notifications:markAll', { teamId: f.teamId });
  expect((await notifications()).page).toHaveLength(0);
  await target.goto(f.url(`issue=${taskId}`));
  await expect(target.getByText('Teammate comment from browser', { exact: true })).toBeVisible();
});

test('O-013 members see only their projects; viewer cannot write across APIs and UI', async ({ clients, f }) => {
  const page = await clients.login(f.viewer);
  await expect(page.getByRole('button', { name: 'Add column', exact: true })).toHaveCount(0);
  const taskId = await f.task('Read-only task');
  await page.goto(f.url(`issue=${taskId}`));
  await expect(page.getByLabel('Issue title', { exact: true })).toBeDisabled();
  const writes = [
    ['tasks:createColumn', { ...f.project, title: 'Forbidden' }],
    ['tasks:updateTask', { ...f.project, taskId, title: 'Forbidden' }],
    ['tasks:deleteTask', { ...f.project, taskId }],
    ['tasks:addComment', { ...f.project, taskId, body: 'Forbidden' }],
    ['wiki:create', { ...f.project, title: 'Forbidden', content: '', type: 'wiki', tags: [] }],
    ['draw:updateElements', { teamId: f.teamId, elements: [] }],
    ['credentials:create', { ...f.project, kind: 'secret', title: 'Forbidden', ciphertext: 'fixture', iv: 'fixture', salt: 'fixture', iterations: 600000, kdf: 'PBKDF2' }],
    ['feedback:configure', { ...f.scope, title: 'Forbidden', description: '', enabled: false }],
  ];
  for (const [name, args] of writes) await expect(f.viewer.api.m(name, args)).rejects.toThrow(/You have view-only access|Only admins can do this/);
  const deniedChat = await page.request.post('/api/local-chat/messages', { headers: { Authorization: `Bearer ${f.viewer.sessionToken}` }, data: { teamId: f.teamId, body: 'Forbidden' } });
  expect(deniedChat.status()).toBe(400);
  expect((await deniedChat.json()).error).toMatch(/read.only|view.only|write|edit/i);
  for (const [person, allowed, denied] of [[f.member, f.alpha, f.beta], [f.other, f.beta, f.alpha]]) {
    expect((await person.api.q('projects:listForUser', { teamId: f.teamId })).map(p => p._id)).toEqual([allowed]);
    await expect(person.api.q('tasks:board', { projectId: denied })).rejects.toThrow(/access/);
    await expect(person.api.m('tasks:createColumn', { projectId: denied, title: 'Forbidden' })).rejects.toThrow(/access/);
  }
  // Writer revocation must take effect on existing credentials too.
  const memberships = await f.admin.api.q('members:list', f.project);
  await f.admin.api.m('members:remove', { ...f.project, memberId: memberships.find(m => m.email === f.member.email)._id });
  await expect(f.member.api.q('tasks:board', f.project)).rejects.toThrow(/access/);
});

test('O-063 O-064 chat and private DMs synchronize without leaking to a third client', async ({ clients, f }) => {
  const a = await clients.login(f.admin, `/${f.workspace.slug}?view=chat`);
  const b = await clients.login(f.member, `/${f.workspace.slug}?view=chat`);
  const c = await clients.login(f.other, `/${f.workspace.slug}?view=chat`);
  await a.getByRole('textbox', { name: 'Message the team', exact: true }).fill('Shared team message');
  await a.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(b.getByText('Shared team message', { exact: true })).toBeVisible();
  await a.getByRole('button', { name: `Message ${f.member.name}`, exact: true }).click();
  await a.getByRole('textbox', { name: 'Direct message', exact: true }).fill('Private DM regression');
  await a.getByRole('button', { name: 'Send message', exact: true }).click();
  await b.getByRole('button', { name: `Message ${f.admin.name}`, exact: true }).click();
  await expect(b.locator('.chat-message-text').filter({ hasText: 'Private DM regression' })).toBeVisible();
  await expect(c.getByText('Private DM regression', { exact: true })).toHaveCount(0);
  const conversations = await local(f.admin, `/api/local-chat/conversations?teamId=${f.teamId}`);
  const conversationId = conversations.conversations[0].id;
  const unauthorized = await c.request.get(`/api/local-chat/messages?teamId=${f.teamId}&conversation=${encodeURIComponent(conversationId)}`, { headers: { Authorization: `Bearer ${f.other.sessionToken}` } });
  expect(unauthorized.ok()).toBe(false);
});

test('O-101 O-102 O-104 vault encrypts in browser, reloads, rejects wrong key and locks', async ({ clients, f }) => {
  const page = await clients.login(f.member, f.url('tab=vault'));
  await page.getByLabel('Passphrase', { exact: true }).fill('fixture-passphrase-123');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'New item', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Secret', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Fixture secret');
  await dialog.getByLabel('Secret', { exact: true }).fill('e2e-secret-value');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Fixture secret', { exact: true })).toBeVisible();
  const stored = (await f.member.api.q('credentials:list', f.project))[0];
  expect(JSON.stringify(stored)).not.toContain('e2e-secret-value');
  await page.getByRole('button', { name: 'Reveal Fixture secret', exact: true }).click();
  await expect(page.getByText('e2e-secret-value', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Lock vault', exact: true }).click();
  await expect(page.getByText('e2e-secret-value', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByLabel('Passphrase', { exact: true }).fill('wrong-passphrase');
  await page.getByRole('button', { name: /^Unlock/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Passphrase', { exact: true }).fill('fixture-passphrase-123');
  await page.getByRole('button', { name: /^Unlock/ }).click();
  await expect(page.getByText('Fixture secret', { exact: true })).toBeVisible();
});

test('O-106 O-107 O-108 feedback public submission appears to two clients', async ({ page, clients, f }) => {
  const admin = await clients.login(f.admin, f.url('tab=feedback'));
  await admin.getByRole('button', { name: 'Set up feedback', exact: true }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill('Fixture feedback portal');
  await dialog.getByLabel('Enable public feedback form').check();
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await f.admin.api.q('feedback:portals', { teamId: f.teamId })).length).toBe(1);
  const portal = (await f.admin.api.q('feedback:portals', { teamId: f.teamId }))[0];
  const member = await clients.login(f.member, f.url('tab=feedback'));
  await page.goto(`/feedback/${portal.slug}`);
  await page.getByLabel('Title', { exact: true }).fill('Customer bug');
  await page.getByLabel('Details', { exact: true }).fill('Deterministic feedback body');
  await page.getByRole('radio', { name: 'Bug', exact: true }).click();
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thank you.' })).toBeVisible();
  await expect(member.getByText('Customer bug', { exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Dismiss Customer bug', exact: true }).click();
  await expect(member.getByText('Customer bug', { exact: true })).toHaveCount(0);
  await member.getByRole('button', { name: 'All', exact: true }).click();
  await expect(member.getByText('Customer bug', { exact: true })).toBeVisible();
  await f.admin.api.m('feedback:configure', { ...f.scope, title: portal.title, description: '', enabled: false });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'This form is unavailable' })).toBeVisible();
});

test('O-016 O-030 settings and project presence update across clients', async ({ clients, f }) => {
  const member = await clients.login(f.member), admin = await clients.login(f.admin);
  await expect(admin.getByLabel(`${f.member.name} is viewing this project`)).toBeVisible();
  await admin.locator('.project-navigation').getByRole('tab', { name: 'Settings', exact: true }).click();
  await admin.getByLabel('Name', { exact: true }).fill('Renamed Alpha');
  await admin.getByRole('button', { name: /^Save/ }).click();
  await expect(member.locator('.project-identity')).toContainText('Renamed Alpha');
  await member.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(admin.getByLabel(`${f.member.name} is viewing this project`)).toHaveCount(0);
});

test('O-076 O-078 O-083 two contexts join and leave a fake-media call', async ({ clients, f }) => {
  const a = await clients.login(f.admin, `/${f.workspace.slug}?view=voice`);
  const b = await clients.login(f.member, `/${f.workspace.slug}?view=voice`);
  await a.getByRole('button', { name: 'Join call', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
  await b.getByRole('button', { name: 'Join call', exact: true }).click();
  await expect(b.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
  await expect.poll(async () => (await local(f.admin, `/api/local-voice/participants?teamId=${f.teamId}`)).participants.length).toBe(2);
  await b.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(b.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeVisible();
  await b.getByRole('button', { name: 'Leave call', exact: true }).click();
  await a.getByRole('button', { name: 'Leave call', exact: true }).click();
  await expect.poll(async () => (await local(f.admin, `/api/local-voice/participants?teamId=${f.teamId}`)).participants.length).toBe(0);
});
