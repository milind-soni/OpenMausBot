/** Cycle-free source of truth for the app-owned host capability surface. */
export const BUILTIN_CAPABILITY_TOOLS = [
  {
    name: "shell_execute",
    description: "Execute a task-scoped host shell command. Catastrophic destruction and credential-value disclosure are centrally denied.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number", minimum: 100, maximum: 300000 },
      },
      required: ["command"],
    },
  },
  {
    name: "filesystem_read",
    description: "Read a UTF-8 host file, excluding credential stores and credential-file content.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, maxBytes: { type: "number" } }, required: ["path"] },
  },
  {
    name: "filesystem_write",
    description: "Write or append UTF-8 content to a task-scoped host file. Agent graphs must supply the exact sha256 returned by a prior read, or 'absent' returned by stat.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" }, expectedSha256: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "filesystem_delete",
    description: "Delete a scoped host path. Broad roots and whole repositories are denied.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: ["path"] },
  },
  {
    name: "filesystem_stat",
    description: "Inspect host path metadata without reading file content.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
] as const;
