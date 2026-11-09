import { compileServerToolSchema } from "../mcp-schema-validator.ts";
import type { WorkflowToolDescriptor } from "./planning.ts";
import type { ToolInvoker } from "./workflow.ts";

export function schemaCheckedInvoker(catalog: readonly WorkflowToolDescriptor[], invoke: ToolInvoker): ToolInvoker {
  const tools = new Map(catalog.map((tool) => [tool.name, tool]));
  const validators = new Map<string, ReturnType<typeof compileServerToolSchema>>();
  return async (name, input, signal) => {
    let validate = validators.get(name);
    if (!validate) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} is not available`);
      if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new Error(`Tool ${name} has no usable input schema`);
      validate = compileServerToolSchema(tool.inputSchema as Record<string, unknown>);
      validators.set(name, validate);
    }
    if (!validate(input)) throw new Error(`The arguments for ${name} no longer match its schema`);
    return invoke(name, input, signal);
  };
}
