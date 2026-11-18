/** An engine's own count of what fills a conversation's context window. Absent wherever the engine does not report one:
 * the harness never estimates a category. */
export interface ContextBreakdown {
  /** Tokens in the window now. */
  tokens: number;
  window: number;
  /** `used` rows are in the window, `buffer` is what the engine holds back for its own compaction and `free` is the
   * rest. `id` is the engine's key for the row; Claude Code's are system_prompt, system_tools, mcp_tools,
   * mcp_instructions, custom_agents, memory_files, skills, messages, autocompact_buffer, compact_buffer and free_space. */
  categories: Array<{ id: string; kind: "used" | "buffer" | "free"; tokens: number }>;
  /** What the `messages` row is made of. */
  messages?: { toolCalls: number; toolResults: number; attachments: number; assistant: number; user: number };
  /** The engine compacts the conversation by itself, at `autoCompactAt` tokens when it says where. */
  autoCompact?: boolean;
  autoCompactAt?: number;
}
