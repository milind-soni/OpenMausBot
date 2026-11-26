import { z } from 'zod';

// ============================================================
// 1. 仅传给 LLM Structured Output 的极简产出契约
//    (严禁包含 telemetry / strikeCount / idempotencyKey / stats)
// ============================================================
export const SubBotLLMOutputSchema = z.object({
  outcome: z.enum(['COMPLETED', 'CONTRACT_CONFLICT']),
  outputData: z.record(z.string(), z.unknown()).optional(),
  conflictEvidence: z.string().max(1024).optional(), // 仅当发现上游契约自相矛盾时填写
});

export type SubBotLLMOutput = z.infer<typeof SubBotLLMOutputSchema>;

// ============================================================
// 2. 调度器内存 DTO (严禁直接 JSON.stringify 进 Prompt，须经 PromptSerializer 映射)
// ============================================================
export const ArtifactPointerSchema = z.object({
  id: z.string(), // 简短别名如 "ART-01"
  summary: z.string().max(160),
  uri: z.string(),
  sha256: z.string().length(64),
  lineRange: z.string().optional(),
});
export type ArtifactPointer = z.infer<typeof ArtifactPointerSchema>;

export const AcceptanceCriteriaSchema = z.object({
  outputSchemaName: z.string(),
  verifierType: z.enum(['CODE_TEST', 'SCHEMA_RULE', 'INDEPENDENT_CRITIC']),
  checks: z.array(z.string()).min(1),
});
export type AcceptanceCriteria = z.infer<typeof AcceptanceCriteriaSchema>;

export const ExecutionProfileSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('GENERAL'),
    draftNamespace: z.string(), // e.g. "drafts/task-01/research/attempt-1"
  }),
  z.object({
    kind: z.literal('ENGINEERING'),
    worktreePath: z.string(),
    branchName: z.string(),
    softDiffWarningLines: z.number().int().positive(), // T1:150, T2:400, T3:800 (仅软警告)
  }),
]);
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

export const BotTaskEnvelopeV3Schema = z.object({
  // --- L1 共享前缀字段 (同主任务下并行兄弟节点一致) ---
  parentTaskId: z.string(),

  // --- Pure Runtime Metadata (仅留内存，不序列化进 Prompt) ---
  expectedBlackboardVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string(), // 格式: `${subtaskId}:attempt-${attempt}`
  limits: z.object({
    maxExecutionTokens: z.number().int().positive(), // T1: 8k, T2: 16k, T3: 32k
    maxToolCalls: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),

  // --- L2 瞬态切片字段 (位于 Cache Breakpoint #2 之后) ---
  subtaskId: z.string(),
  attempt: z.union([z.literal(1), z.literal(2)]),
  tier: z.enum(['T1_FAST', 'T2_STANDARD', 'T3_CRITICAL']),
  goal: z.string().max(300),

  // 领域判别联合：非代码 Bot 零 Git 基建负担，代码 Bot 保留 Worktree 强隔离
  executionProfile: ExecutionProfileSchema,

  // 4 选 1 确定性高信噪比上下文 (弹性 800 ~ 3500 Tokens)
  context: z.object({
    upstreamSlices: z.record(z.string(), z.unknown()),
    contractRules: z.array(z.string()),
    forbiddenScope: z.array(z.string()),
    examples: z
      .object({
        good: z.string(),
        bad: z.string().optional(),
      })
      .optional(),
  }),

  // 内部存真实 uri+sha256，PromptSerializer 仅向模型暴露 { id, summary, lineRange }
  artifactPointers: z.array(ArtifactPointerSchema).optional(),

  // 验收门禁 (DoD) —— 主观类门禁严禁模型自评
  acceptanceCriteria: AcceptanceCriteriaSchema,
});

export type BotTaskEnvelopeV3 = z.infer<typeof BotTaskEnvelopeV3Schema>;

// ============================================================
// 3. Runtime Harness 自动拼装的完整状态增量 (写黑板/门禁/遥测用)
// ============================================================
export const BotHandoffDeltaV3Schema = z.object({
  subtaskId: z.string(),
  idempotencyKey: z.string(),
  status: z.enum([
    'SUCCESS',
    'NEED_RETRY',        // Strike 1: 本地确定性校验失败，携精确断言切片原地修正
    'CONTRACT_CONFLICT', // 上游契约矛盾，干净暂停并上报证据
    'STALE_POINTER',     // 工具层检测到产物哈希变更，刷新重派（不计入 Strike）
    'CIRCUIT_BROKEN',    // Strike 2: 触发两振熔断，严禁同级模型第 3 次盲改
  ]),
  strikeCount: z.union([z.literal(0), z.literal(1), z.literal(2)]),

  outputData: z.record(z.string(), z.unknown()).optional(),
  artifactUri: z.string().optional(),

  engineeringStats: z
    .object({
      filesChanged: z.number().int().nonnegative(),
      insertions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      diffBudgetExceeded: z.boolean(), // 软警告标记，不直接判 FAILED
      patchUri: z.string().optional(),
    })
    .optional(),

  verification: z.object({
    passed: z.boolean(),
    verifierType: z.enum(['CODE_TEST', 'SCHEMA_RULE', 'INDEPENDENT_CRITIC']),
    summary: z.string().max(400),
  }),

  telemetry: z.object({
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheHitRate: z.number().min(0).max(1),
  }),

  diagnostics: z
    .object({
      errorSnippet: z.string().max(2048),
      conflictEvidence: z.string().max(1024).optional(),
      traceLogUri: z.string(),
    })
    .optional(),
});

export type BotHandoffDeltaV3 = z.infer<typeof BotHandoffDeltaV3Schema>;

// ============================================================
// 4. 单兵 Bot 内部并行子代理架构扩展 (v3.1)
// ============================================================
export const IntraBotSubagentEnvelopeSchema = BotTaskEnvelopeV3Schema.extend({
  invocationScope: z.literal('INTRA_SUBAGENT'),
  maxDepth: z.literal(1), // 运行时校验：Tool Registry 物理剥离 spawn 类工具
  isolationPolicy: z.discriminatedUnion('role', [
    z.object({
      role: z.literal('SCOUT'),
      allowFileWriteTools: z.literal(false),
    }),
    z.object({
      role: z.literal('VERIFIER'),
      allowFileWriteTools: z.literal(false),
      allowedCommandPrefixes: z.array(z.string()).min(1), // 如 ['pnpm test', 'pnpm tsc', 'pnpm lint']
      isolatedEnv: z.record(z.string(), z.string()),    // 如 { PORT: '0', TMPDIR: '...' }
    }),
    z.object({
      role: z.literal('DISJOINT_BUILDER'),
      allowedWritePrefixes: z.array(z.string()).min(1), // 经最近祖先 realpath + path.sep 校验
      forbiddenSharedFiles: z.array(z.string()),        // 如 ['package.json', 'src/index.ts']
    }),
  ]),
});

export type IntraBotSubagentEnvelope = z.infer<typeof IntraBotSubagentEnvelopeSchema>;

export const IntraBotBatchRequestSchema = z.object({
  concurrencySlotLimit: z.number().int().min(1).max(5).default(4),
  cacheWarmup: z
    .object({
      enabled: z.boolean().default(true),
      waitForFirstTokenMsCap: z.number().int().max(3000).default(2500),
    })
    .default({ enabled: true, waitForFirstTokenMsCap: 2500 }),
  tasks: z.array(IntraBotSubagentEnvelopeSchema).min(1).max(10),
});

export type IntraBotBatchRequest = z.infer<typeof IntraBotBatchRequestSchema>;
