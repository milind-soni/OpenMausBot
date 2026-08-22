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
    description: "Write or append UTF-8 content to a task-scoped host file.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } }, required: ["path", "content"] },
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

/** Cycle-free source of truth for the metadata-only fleet discovery surface. */
export const FLEET_BUILTIN_TOOLS = [
  {
    name: "search_capabilities",
    description: "Search the metadata-only fleet index for MCPs, skills, scripts, and other capabilities without loading their schemas or instructions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string" },
        surface: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 25 },
      },
    },
  },
  {
    name: "suggest_capabilities",
    description: "Suggest a small task-relevant set of fleet capability metadata and advisory role overlays.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 25 } },
      required: ["task"],
    },
  },
  {
    name: "select_capability",
    description: "Select one exact fleet capability and return its safe lazy route, if this runtime can verify one.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "suggest_role_overlays",
    description: "Suggest non-privileged portfolio specialist roles for the current task.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 5 } },
      required: ["task"],
    },
  },
] as const;
