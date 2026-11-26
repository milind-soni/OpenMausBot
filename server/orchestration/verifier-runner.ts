import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { IntraBotSubagentManager } from './subagent.ts';
import type { VerificationCheckResult } from './harness.ts';

const execFileAsync = promisify(execFile);

export interface VerifierRunnerOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  retainTmpDir?: boolean;
}

export interface VerifierExecutionResult {
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  errorSnippet?: string;
  isolatedTmpDir: string;
}

export class VerifierRunner {
  /**
   * Tokenizes a command line string into arguments respecting double and single quotes.
   */
  public static tokenizeCommandLine(commandLine: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote: '"' | "'" | null = null;

    for (let i = 0; i < commandLine.length; i++) {
      const ch = commandLine[i];
      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null;
        } else {
          current += ch;
        }
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (/\s/.test(ch)) {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }

    if (current.length > 0) {
      tokens.push(current);
    }

    return tokens;
  }

  /**
   * Resolves the executable path on Windows if needed (e.g. pnpm -> pnpm.cmd).
   */
  public static resolveExecutable(cmd: string, cwd?: string): string {
    if (process.platform === 'win32') {
      const ext = path.extname(cmd);
      if (!ext) {
        const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
        if (cmd.includes(path.sep) || cmd.includes('/')) {
          const basePath = cwd ? path.resolve(cwd, cmd) : path.resolve(cmd);
          for (const pe of pathext) {
            const candidate = `${basePath}${pe.toLowerCase()}`;
            if (fs.existsSync(candidate)) return candidate;
            const candidateUpper = `${basePath}${pe.toUpperCase()}`;
            if (fs.existsSync(candidateUpper)) return candidateUpper;
          }
        } else {
          const pathEnv = process.env.PATH || '';
          const pathDirs = pathEnv.split(path.delimiter);
          for (const dir of pathDirs) {
            for (const pe of pathext) {
              const candidate = path.join(dir, `${cmd}${pe.toLowerCase()}`);
              if (fs.existsSync(candidate)) return candidate;
              const candidateUpper = path.join(dir, `${cmd}${pe.toUpperCase()}`);
              if (fs.existsSync(candidateUpper)) return candidateUpper;
            }
          }
        }
      }
    }
    return cmd;
  }

  /**
   * Executes a command string safely using child_process.execFile with { shell: false }.
   * Enforces whitelist validation, isolation environment (PORT=0, dedicated TMPDIR),
   * and blocks dangerous flags.
   */
  public static async runCommand(
    commandLine: string,
    allowedPrefixes: string[],
    options: VerifierRunnerOptions = {}
  ): Promise<VerifierExecutionResult> {
    const startTime = Date.now();

    // 1. Check against whitelist & forbidden operators/flags
    const check = IntraBotSubagentManager.isCommandAllowedForVerifier(commandLine, allowedPrefixes);
    if (!check.allowed) {
      return {
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: check.reason ?? 'Command validation failed',
        durationMs: Date.now() - startTime,
        errorSnippet: check.reason,
        isolatedTmpDir: '',
      };
    }

    // 2. Tokenize commandLine into [binary, ...args] respecting quotes
    const tokens = this.tokenizeCommandLine(commandLine);
    const rawBinary = tokens[0];
    const args = tokens.slice(1);

    if (!rawBinary) {
      return {
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: 'Empty command line',
        durationMs: Date.now() - startTime,
        errorSnippet: 'Empty command line',
        isolatedTmpDir: '',
      };
    }

    const binary = this.resolveExecutable(rawBinary, options.cwd);
    const isWinCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    if (isWinCmdShim) {
      const cmdUnsafePattern = /[%^!()&|<>;\r\n"`$]/;
      if ([binary, ...args].some((token) => cmdUnsafePattern.test(token))) {
        const reason = 'Command contains unsafe cmd.exe metacharacters for .cmd/.bat execution.';
        return {
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: reason,
          durationMs: Date.now() - startTime,
          errorSnippet: reason,
          isolatedTmpDir: '',
        };
      }
    }

    // 3. Create isolated temp directory
    const prefix = path.join(os.tmpdir(), 'omb-verifier-');
    const isolatedTmpDir = await fs.promises.mkdtemp(prefix);

    // 4. Inject isolated environment: PORT=0, TMPDIR, TEMP, TMP, CI=1, PAGER=cat
    const isolatedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: '0',
      TMPDIR: isolatedTmpDir,
      TEMP: isolatedTmpDir,
      TMP: isolatedTmpDir,
      CI: '1',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      ...options.env,
    };

    const timeout = options.timeoutMs ?? 30000;

    try {
      const execTarget = isWinCmdShim ? (process.env.ComSpec ?? 'cmd.exe') : binary;
      const execArgs = isWinCmdShim
        ? ['/d', '/s', '/c', `"${[binary, ...args].map((t) => `"${t}"`).join(' ')}"`]
        : args;
      const { stdout, stderr } = await execFileAsync(execTarget, execArgs, {
        shell: false,
        ...(isWinCmdShim ? { windowsVerbatimArguments: true } : {}),
        cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
        env: isolatedEnv,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        passed: true,
        exitCode: 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: Date.now() - startTime,
        isolatedTmpDir,
      };
    } catch (err: unknown) {
      const execErr = err as {
        code?: number | string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };

      const stdout = execErr.stdout ? execErr.stdout.toString() : '';
      const stderr = execErr.stderr ? execErr.stderr.toString() : (execErr.message ?? 'Unknown execution error');
      const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;

      return {
        passed: false,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        errorSnippet: (stderr || stdout || execErr.message || 'Command exited with non-zero status').slice(0, 2048),
        isolatedTmpDir,
      };
    } finally {
      if (!options.retainTmpDir) {
        try {
          await fs.promises.rm(isolatedTmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  /**
   * Helper that produces a VerificationCheckResult suitable for RuntimeHarness.processHandoff
   */
  public static async runAsVerificationCheck(
    commandLine: string,
    allowedPrefixes: string[],
    options: VerifierRunnerOptions = {}
  ): Promise<VerificationCheckResult> {
    const res = await this.runCommand(commandLine, allowedPrefixes, options);
    if (res.passed) {
      return {
        passed: true,
        verifierType: 'CODE_TEST',
        summary: `Verification command '${commandLine}' passed with exit code 0.`,
      };
    }
    return {
      passed: false,
      verifierType: 'CODE_TEST',
      summary: `Verification command '${commandLine}' failed with exit code ${res.exitCode}.`,
      errorSnippet: res.errorSnippet,
    };
  }
}
