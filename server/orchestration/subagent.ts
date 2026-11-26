import path from 'node:path';
import fs from 'node:fs';
import {
  type IntraBotSubagentEnvelope,
  type IntraBotBatchRequest,
  IntraBotSubagentEnvelopeSchema,
  IntraBotBatchRequestSchema,
} from './contracts.ts';

export interface GroupedSubagentBatch {
  prefixKey: string; // modelId + prefixHash
  modelId: string;
  tasks: IntraBotSubagentEnvelope[];
}

export interface WarmupGateResult {
  warmedUp: boolean;
  reason: 'TTFT_RESOLVED' | 'ERROR_FAIL_OPEN' | 'TIMEOUT_FAIL_OPEN';
}

export class IntraBotSubagentManager {
  /**
   * Validate subagent isolation policy and depth guard.
   * Ensures subagents cannot invoke or spawn other subagents (Max Depth = 1).
   */
  public static validateEnvelope(envelope: unknown): IntraBotSubagentEnvelope {
    return IntraBotSubagentEnvelopeSchema.parse(envelope);
  }

  /**
   * Verifies if a command prefix is strictly permitted for VERIFIER subagent.
   * Prevents shell chaining, redirection, or unauthorized command execution.
   */
  public static isCommandAllowedForVerifier(
    command: string,
    allowedPrefixes: string[]
  ): { allowed: boolean; reason?: string } {
    const trimmed = command.trim();

    // Block dangerous shell operators
    const forbiddenOperators = [';', '&&', '||', '|', '>', '<', '`', '$(', '&', '\n', '\r', '${'];
    for (const op of forbiddenOperators) {
      if (trimmed.includes(op)) {
        const displayOp = op === '\n' ? '\\n' : op === '\r' ? '\\r' : op;
        return {
          allowed: false,
          reason: `Command contains forbidden shell operator '${displayOp}'. Shell: false required.`,
        };
      }
    }

    // Block forbidden test flags (snapshot mutations and interactive watch modes)
    const forbiddenFlags = [
      '-u',
      '--updateSnapshot',
      '--updateSnapshots',
      '--update-snapshots',
      '-w',
      '--watch',
      '--watchAll',
    ];
    const tokens = trimmed.split(/\s+/);
    for (const token of tokens) {
      for (const flag of forbiddenFlags) {
        if (token === flag || token.startsWith(flag + '=')) {
          return {
            allowed: false,
            reason: `Command contains forbidden flag '${token}'. Snapshot mutation and watch mode are forbidden.`,
          };
        }
      }
    }

    const matchesPrefix = allowedPrefixes.some((prefix) => {
      const cleanPrefix = prefix.trim();
      return trimmed === cleanPrefix || trimmed.startsWith(cleanPrefix + ' ');
    });

    if (!matchesPrefix) {
      return {
        allowed: false,
        reason: `Command '${trimmed}' does not match any allowed command prefix: ${allowedPrefixes.join(', ')}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Safely checks write target path against allowed write prefixes for DISJOINT_BUILDER.
   * Walks up to closest existing ancestor directory to resolve realpath safely and
   * reconstructs remainder path segments for non-existent target files.
   */
  public static isPathAllowedForBuilder(
    targetFilePath: string,
    allowedPrefixes: string[],
    forbiddenSharedFiles: string[] = []
  ): { allowed: boolean; reason?: string } {
    const normalizedTarget = path.resolve(targetFilePath);

    // Resolve closest existing ancestor realpath or file realpath
    let effectiveTarget: string;
    if (fs.existsSync(normalizedTarget)) {
      effectiveTarget = fs.realpathSync(normalizedTarget);
    } else {
      let current = path.dirname(normalizedTarget);
      const parts = [path.basename(normalizedTarget)];
      let resolvedExistingAncestor = '';
      while (current && current !== path.dirname(current)) {
        if (fs.existsSync(current)) {
          resolvedExistingAncestor = fs.realpathSync(current);
          break;
        }
        parts.unshift(path.basename(current));
        current = path.dirname(current);
      }
      effectiveTarget = resolvedExistingAncestor
        ? path.join(resolvedExistingAncestor, ...parts)
        : normalizedTarget;
    }

    // Check shared forbidden files (e.g. package.json, index.ts)
    // Prevent partial match like 'subpackage.json' when 'package.json' is forbidden
    for (const forbidden of forbiddenSharedFiles) {
      const normForbidden = path.normalize(forbidden);
      if (
        effectiveTarget === normForbidden ||
        effectiveTarget.endsWith(path.sep + normForbidden) ||
        normalizedTarget === normForbidden ||
        normalizedTarget.endsWith(path.sep + normForbidden)
      ) {
        return {
          allowed: false,
          reason: `Modification of shared root entry '${forbidden}' is forbidden for builder.`,
        };
      }
    }

    // Check against allowed prefixes with mandatory trailing path separator
    const allowed = allowedPrefixes.some((prefix) => {
      const realPrefix = fs.existsSync(prefix)
        ? fs.realpathSync(prefix)
        : path.resolve(prefix);
      const withSep = realPrefix.endsWith(path.sep) ? realPrefix : realPrefix + path.sep;
      return effectiveTarget.startsWith(withSep) || effectiveTarget === realPrefix;
    });

    if (!allowed) {
      return {
        allowed: false,
        reason: `Target path '${targetFilePath}' is outside allowed write prefixes: ${allowedPrefixes.join(', ')}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Groups batch tasks by (modelId + prefixHash) for staggered cache warmup (Wait-for-TTFT).
   */
  public static groupBatchByPrefix(
    batch: IntraBotBatchRequest,
    modelResolver: (task: IntraBotSubagentEnvelope) => { modelId: string; prefixHash: string }
  ): GroupedSubagentBatch[] {
    const verifiedBatch = IntraBotBatchRequestSchema.parse(batch);
    const groups = new Map<string, GroupedSubagentBatch>();

    for (const task of verifiedBatch.tasks) {
      const { modelId, prefixHash } = modelResolver(task);
      const groupKey = `${modelId}::${prefixHash}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          prefixKey: groupKey,
          modelId,
          tasks: [],
        };
        groups.set(groupKey, group);
      }
      group.tasks.push(task);
    }

    return Array.from(groups.values());
  }

  /**
   * Runtime coordinator gate for pioneer subagent prompt cache warmup.
   * Resolves TTFT_RESOLVED when pioneer yields first token within cap,
   * otherwise fails open (TIMEOUT_FAIL_OPEN or ERROR_FAIL_OPEN) to prevent stalling.
   */
  public static async waitForWarmupGate(
    pioneerFirstTokenPromise: Promise<unknown>,
    timeoutMsCap = 2500
  ): Promise<WarmupGateResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<WarmupGateResult>((resolve) => {
      timer = setTimeout(() => resolve({ warmedUp: false, reason: 'TIMEOUT_FAIL_OPEN' }), timeoutMsCap);
    });

    const workPromise = pioneerFirstTokenPromise
      .then(() => {
        if (timer) clearTimeout(timer);
        return { warmedUp: true, reason: 'TTFT_RESOLVED' as const };
      })
      .catch(() => {
        if (timer) clearTimeout(timer);
        return { warmedUp: false, reason: 'ERROR_FAIL_OPEN' as const };
      });

    return Promise.race([workPromise, timeoutPromise]);
  }
}
