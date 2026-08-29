// Thin stdio MCP proxy around Cua Driver.
//
// Cursor Agent truncates large MCP bind responses before the model can use
// the opaque browser tab ids. Cua deliberately returns every profile tab, so
// a busy signed-in Chrome profile can cross that limit. This proxy adds an
// optional bind-only `tab_url_prefix` hint and emits a compact bind response.
// All other MCP traffic is passed through unchanged.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

function textJson(block) {
  if (!block || block.type !== "text" || typeof block.text !== "string") return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return null;
  }
}

function compactBindResult(payload, urlPrefix) {
  if (payload?.status !== "ok" || payload?.mode !== "bind" || !Array.isArray(payload.tabs)) return payload;
  const allTabs = payload.tabs;
  const selectedTabs = typeof urlPrefix === "string" && urlPrefix
    ? allTabs.filter((tab) => typeof tab?.url === "string" && tab.url.startsWith(urlPrefix))
    : allTabs;
  const tabs = selectedTabs.map((tab) => ({
    tab_id: tab?.tab_id,
    url: typeof tab?.url === "string" ? tab.url.slice(0, 512) : "",
    active: tab?.active === true,
  }));
  return {
    status: "ok",
    mode: "bind",
    target_id: payload.target_id,
    ...(tabs.length === 1 ? { tab_id: tabs[0].tab_id } : {}),
    tabs,
    total_tab_count: allTabs.length,
    ...(typeof urlPrefix === "string" && urlPrefix ? { tab_url_prefix: urlPrefix } : {}),
  };
}

export function createCuaMcpTransformer() {
  const pending = new Map();

  return {
    toDriver(message) {
      if (message?.method !== "tools/call" || message?.params?.name !== "get_browser_state") return message;
      const args = message.params.arguments;
      const bind = args && Number.isInteger(args.pid) && Number.isInteger(args.window_id);
      if (!bind) return message;
      const urlPrefix = typeof args.tab_url_prefix === "string" ? args.tab_url_prefix.slice(0, 512) : undefined;
      pending.set(String(message.id), { urlPrefix });
      const { tab_url_prefix: _ignored, ...driverArgs } = args;
      return { ...message, params: { ...message.params, arguments: driverArgs } };
    },

    fromDriver(message) {
      if (message?.id != null && pending.has(String(message.id))) {
        const context = pending.get(String(message.id));
        pending.delete(String(message.id));
        const content = message?.result?.content;
        if (!Array.isArray(content)) return message;
        const structured = compactBindResult(message?.result?.structuredContent, context.urlPrefix);
        const compactText = structured?.status === "ok" && structured?.mode === "bind"
          ? JSON.stringify(structured)
          : null;
        return {
          ...message,
          result: {
            ...message.result,
            ...(structured ? { structuredContent: structured } : {}),
            content: content.map((block, index) => {
              if (compactText && index === 0 && block?.type === "text") return { ...block, text: compactText };
              const payload = textJson(block);
              if (!payload) return block;
              return { ...block, text: JSON.stringify(compactBindResult(payload, context.urlPrefix)) };
            }),
          },
        };
      }

      const tools = message?.result?.tools;
      if (!Array.isArray(tools)) return message;
      return {
        ...message,
        result: {
          ...message.result,
          tools: tools.map((tool) => {
            if (tool?.name !== "get_browser_state") return tool;
            return {
              ...tool,
              description: `${tool.description ?? ""} In bind mode, pass tab_url_prefix to return only matching tabs and avoid host output truncation.`,
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...tool.inputSchema?.properties,
                  tab_url_prefix: {
                    type: "string",
                    description: "Bind-only exact URL-prefix filter. The proxy removes it before calling Cua and returns only matching tabs.",
                  },
                },
              },
            };
          }),
        },
      };
    },
  };
}

function pipeJsonLines(readable, writable, transform, endWritable = false) {
  let buffer = "";
  readable.setEncoding("utf8");
  readable.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        writable.write(`${JSON.stringify(transform(JSON.parse(line)))}\n`);
      } catch {
        writable.write(`${line}\n`);
      }
    }
  });
  readable.on("end", () => {
    if (buffer) writable.write(buffer);
    if (endWritable) writable.end();
  });
}

export function runCuaMcpProxy(argv = process.argv.slice(2)) {
  const [driver, encodedArgs] = argv;
  if (!driver || !encodedArgs) throw new Error("usage: cua-mcp-proxy <driver> <json-args>");
  const driverArgs = JSON.parse(encodedArgs);
  if (!Array.isArray(driverArgs) || !driverArgs.every((value) => typeof value === "string")) {
    throw new Error("invalid cua-driver argument list");
  }
  const child = spawn(driver, driverArgs, {
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const transformer = createCuaMcpTransformer();
  pipeJsonLines(process.stdin, child.stdin, transformer.toDriver, true);
  pipeJsonLines(child.stdout, process.stdout, transformer.fromDriver);
  child.once("exit", (code) => process.exit(code ?? 1));
  child.once("error", (error) => {
    process.stderr.write(`cua mcp proxy failed: ${error.message}\n`);
    process.exit(1);
  });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.once("SIGINT", () => child.kill("SIGINT"));
}

if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || process.argv[1].replace(/\\/g, "/").endsWith("/cua-mcp-proxy.mjs"))) {
  runCuaMcpProxy();
}
