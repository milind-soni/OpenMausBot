import { mkdir, mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash, baseEnvironment, scopedEnvironment, RunError } from './security.mjs';
import { command } from './process.mjs';

export async function temporaryEnvironment(root, run) {
  const variables = scopedEnvironment(run.environmentVariables);
  if (run.gitCredential?.expiresAt && run.gitCredential.expiresAt <= Date.now()) throw new RunError('needs_auth', 'Repository credential expired');
  await mkdir(join(root, 'temporary'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'temporary', 'run-'));
  try {
    const environmentFile = join(directory, 'environment.json');
    await writeFile(environmentFile, JSON.stringify(variables), { mode: 0o600 });
    const gitEnv = baseEnvironment({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Origin Runner', GIT_AUTHOR_EMAIL: 'origin-runner@localhost', GIT_COMMITTER_NAME: 'Origin Runner', GIT_COMMITTER_EMAIL: 'origin-runner@localhost' });
    const askpass = join(directory, 'git-askpass');
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$ORIGIN_GIT_USERNAME" ;; *) printf "%s\\n" "$ORIGIN_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
    Object.assign(gitEnv, { GIT_ASKPASS: askpass, ORIGIN_GIT_USERNAME: run.gitCredential?.username ?? '', ORIGIN_GIT_TOKEN: run.gitCredential?.token ?? '' });
    return { directory, environmentFile, variables, gitEnv, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (cause) { throw Object.assign(new Error('Cannot prove temporary credential cleanup'), { cleanupIncomplete: true, cause }); }
    throw error;
  }
}
export class Workspace {
  constructor(root, run, temporary, options = {}) {
    this.run = run; this.temporary = temporary; this.signal = options.signal; this.onOutput = options.onOutput;
    this.allowLocal = options.allowLocal === true;
    this.repository = resolve(root, 'repositories', hash(run.repositoryUrl));
    this.path = resolve(root, 'worktrees', hash(run.id).slice(0, 24));
    this.checkpointBranch = `origin-checkpoints/${hash(run.id).slice(0, 24)}`;
  }
  git(args, cwd = this.path, extra = {}) {
    const location = cwd === this.path && this.gitDirectory ? ['--git-dir', this.gitDirectory, '--work-tree', this.path] : [];
    return command('git', [...location, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', ...args], { cwd, env: this.temporary.gitEnv, signal: this.signal, timeoutMs: 120000, ...extra });
  }
  async prepare() {
    if (!this.allowLocal) {
      const url = new URL(this.run.repositoryUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Repository must be credential-free HTTPS');
    }
    if (this.run.branch === this.run.baseBranch || /^(main|master)$/.test(this.run.branch)) throw new Error('Runner cannot write the protected base branch');
    await command('git', ['check-ref-format', '--branch', this.run.branch]);
    await command('git', ['check-ref-format', '--branch', this.run.baseBranch]);
    await mkdir(this.repository, { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.path, '..'), { recursive: true, mode: 0o700 });
    try { await access(join(this.repository, 'HEAD')); }
    catch { await this.git(['init', '--bare', this.repository], this.repository); }
    await this.git(['fetch', '--no-tags', '--', this.run.repositoryUrl, `+refs/heads/${this.run.baseBranch}:refs/origin/base`], this.repository);
    this.baseSha = (await this.git(['rev-parse', 'refs/origin/base'], this.repository)).stdout.trim();
    let start = this.baseSha;
    if (this.run.resume?.checkpointSha) {
      if (!/^[a-f0-9]{40,64}$/.test(this.run.resume.checkpointSha)) throw new Error('Invalid checkpoint SHA');
      await this.git(['fetch', '--no-tags', '--', this.run.repositoryUrl, this.run.resume.checkpointSha], this.repository);
      await this.git(['merge-base', '--is-ancestor', this.baseSha, this.run.resume.checkpointSha], this.repository);
      start = this.run.resume.checkpointSha;
    }
    // No reset, force, or reuse: a duplicate claim can never overwrite an existing checkout.
    await this.git(['worktree', 'add', '-b', this.run.branch, this.path, start], this.repository);
    this.gitDirectory = (await this.git(['rev-parse', '--absolute-git-dir'])).stdout.trim();
    if (!this.gitDirectory.startsWith(`${this.repository}/worktrees/`)) throw new Error('Git worktree metadata escaped the isolated repository');
    return this.path;
  }
  async assertNoSecrets(redactor, revision) {
    const objects = (await this.git(['rev-list', '--objects', `${this.baseSha}..${revision}`])).stdout.trim().split('\n').filter(Boolean);
    for (const entry of objects) {
      const sha = entry.split(' ')[0];
      const type = (await this.git(['cat-file', '-t', sha])).stdout.trim();
      if (!['blob', 'commit', 'tag', 'tree'].includes(type)) throw new Error('Unexpected git object type');
      const size = Number((await this.git(['cat-file', '-s', sha])).stdout.trim());
      if (size > 16 * 1024 * 1024) throw new Error('Refusing push: changed object exceeds secret inspection limit (16 MiB)');
      const content = (await this.git(['cat-file', '-p', sha], this.path, { maxOutput: 17 * 1024 * 1024 })).stdout;
      if (redactor.containsSecret(content)) throw new Error('Refusing push: possible secret in new git objects');
    }
  }
  async checkpoint(summary, redactor, { push = true } = {}) {
    await this.git(['add', '--all', '--', '.']);
    const dirty = await this.git(['diff', '--cached', '--quiet'], this.path, { allowFailure: true });
    if (dirty.code === 1) await this.git(['commit', '-m', summary]);
    else if (dirty.code !== 0) throw new Error('Unable to inspect staged checkpoint');
    const sha = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    await this.git(['update-ref', `refs/heads/${this.checkpointBranch}`, sha], this.repository);
    await this.assertNoSecrets(redactor, sha);
    if (push) {
      await this.git(['push', '--porcelain', '--', this.run.repositoryUrl, `${sha}:refs/heads/${this.run.branch}`, `${sha}:refs/heads/${this.checkpointBranch}`]);
      const remote = (await this.git(['ls-remote', '--heads', '--', this.run.repositoryUrl, `refs/heads/${this.run.branch}`])).stdout.trim().split(/\s/)[0];
      if (remote !== sha) throw new Error('Pushed branch does not match verified head');
    }
    return { sha, branch: this.run.branch, summary };
  }
  async verify(redactor) {
    if (!Array.isArray(this.run.verificationCommands) || !this.run.verificationCommands.length || !this.run.smokeCommand?.trim()) throw new Error('Verification commands and smoke command are required');
    const results = [];
    for (const [kind, cmd] of [...this.run.verificationCommands.map(value => ['test', value]), ['smoke', this.run.smokeCommand]]) {
      if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('Empty verification command');
      const result = await command('/bin/sh', ['-c', cmd], { cwd: this.path, env: baseEnvironment(this.temporary.variables), signal: this.signal, timeoutMs: this.run.timeoutSeconds * 1000, allowFailure: true, onOutput: this.onOutput });
      results.push({ command: redactor.text(cmd), exitCode: result.code, kind, summary: redactor.text((result.stderr || result.stdout).slice(-1000)) });
      if (result.code !== 0) break;
    }
    return results;
  }
}
