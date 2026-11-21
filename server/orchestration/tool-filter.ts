import type { IntraBotSubagentEnvelope } from './contracts.ts';
import { IntraBotSubagentManager } from './subagent.ts';

export const RECURSIVE_SPAWN_TOOLS: ReadonlySet<string> = new Set([
  'spawn_subagent',
  'invoke_subagent',
  'coordinate_bots',
  'start_thread',
  'burst',
  'subagent',
  'define_subagent',
  'manage_subagents',
  'delegate_task',
]);

export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'client_create_file',
  'client_edit_file',
  'client_write_file',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'patch_file',
  'append_file',
  'save_file',
]);

export interface ToolDescriptor {
  name: string;
  [key: string]: unknown;
}

export class ToolFilter {
  /**
   * Check if a tool is a recursive spawn tool forbidden by Max Depth = 1 rule.
   */
  public static isRecursiveSpawnTool(toolName: string): boolean {
    return RECURSIVE_SPAWN_TOOLS.has(toolName);
  }

  /**
   * Check if a tool is a file mutation/write tool.
   */
  public static isFileWriteTool(toolName: string): boolean {
    return FILE_WRITE_TOOLS.has(toolName);
  }

  /**
   * Physically strip forbidden tools from tool name list based on Max Depth = 1
   * and subagent isolation policy.
   */
  public static filterToolNamesForSubagent(
    toolNames: string[],
    envelope: IntraBotSubagentEnvelope
  ): string[] {
    const { isolationPolicy } = envelope;

    return toolNames.filter((toolName) => {
      // 1. Max Depth = 1: Always strip recursive spawn tools
      if (this.isRecursiveSpawnTool(toolName)) {
        return false;
      }

      // 2. SCOUT & VERIFIER: Strip file write tools
      if (isolationPolicy.role === 'SCOUT' || isolationPolicy.role === 'VERIFIER') {
        if (this.isFileWriteTool(toolName)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Physically strip forbidden tools from tool descriptor list.
   */
  public static filterToolDefinitionsForSubagent<T extends ToolDescriptor>(
    tools: T[],
    envelope: IntraBotSubagentEnvelope
  ): T[] {
    const { isolationPolicy } = envelope;

    return tools.filter((tool) => {
      if (this.isRecursiveSpawnTool(tool.name)) {
        return false;
      }

      if (isolationPolicy.role === 'SCOUT' || isolationPolicy.role === 'VERIFIER') {
        if (this.isFileWriteTool(tool.name)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Runtime interception gate for tool calls dispatched by subagent.
   * Enforces write boundary invariants for DISJOINT_BUILDER and halts unauthorized mutations.
   */
  public static assertToolCallPermitted(
    toolName: string,
    args: Record<string, unknown>,
    envelope: IntraBotSubagentEnvelope
  ): void {
    const { isolationPolicy } = envelope;

    // 1. Recursive spawn interception
    if (this.isRecursiveSpawnTool(toolName)) {
      throw new Error(
        `Security violation: Subagent cannot invoke tool '${toolName}'. Recursive subagent spawning is forbidden by Max Depth = 1 rule.`
      );
    }

    // 2. SCOUT / VERIFIER write interception
    if (isolationPolicy.role === 'SCOUT' || isolationPolicy.role === 'VERIFIER') {
      if (this.isFileWriteTool(toolName)) {
        throw new Error(
          `Security violation: Subagent '${isolationPolicy.role}' is not authorized to call file write tool '${toolName}'.`
        );
      }
    }

    // 3. DISJOINT_BUILDER target boundary interception
    if (isolationPolicy.role === 'DISJOINT_BUILDER' && this.isFileWriteTool(toolName)) {
      const targetPath = (args.target_file ??
        args.targetFile ??
        args.filePath ??
        args.path ??
        args.target ??
        args.absolute_path ??
        '') as string;

      if (!targetPath) {
        throw new Error(`Security violation: Tool '${toolName}' called without required target path parameter.`);
      }

      const check = IntraBotSubagentManager.isPathAllowedForBuilder(
        targetPath,
        isolationPolicy.allowedWritePrefixes,
        isolationPolicy.forbiddenSharedFiles
      );

      if (!check.allowed) {
        throw new Error(
          `Security violation: DISJOINT_BUILDER write blocked by path filter: ${check.reason}`
        );
      }
    }
  }
}
