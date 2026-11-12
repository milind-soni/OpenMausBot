#!/usr/bin/env node
// A self-contained development agent for OpenMausBot: a tool loop over the
// OpenRouter chat API. Any model that speaks OpenRouter tool calling can drive
// it; OMB_AGENT_MODEL picks which one (default: the cheap background-tier
// model). The agent can read, search, write and run commands, but only inside
// this repository, and it can never push.
//
//   node agent/omb-agent.mjs "task..." [--model owner/model] [--max-turns 25]
//   node agent/omb-agent.mjs --self-test
import { exec } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const MAX_OUTPUT_CHARS = 8000;

const SYSTEM = `You are a development agent working inside the OpenMausBot repository.
Facts you must rely on:
- pnpm monorepo, TypeScript strict. Tests: \`pnpm vitest run <paths>\`. Lint: \`pnpm exec oxlint --deny-warnings <paths>\`. Typecheck: \`pnpm exec tsc -b tsconfig.server.json\`.
- Never verify changes against a live app, live account or live data; tests and temporary directories only.
- Write comments only for licences, external-forced behaviour, public contracts and security invariants. No narration, no history, no commented-out code.
- Before finishing, run the tests, lint and typecheck for every file you touched and report their real exit status.
Work step by step with the tools. When the task is done, reply with a short summary and nothing else; the loop ends then.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files under a path (default: the repository root), newest first.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Repository-relative directory" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Returns numbered lines.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative file path" },
          offset: { type: "number", description: "1-based first line (default 1)" },
          limit: { type: "number", description: "Maximum lines to return (default 400)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regular expression. Returns path:line: text, capped.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression" },
          path: { type: "string", description: "Repository-relative directory or file (default: root)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or completely replace a file inside the repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative file path" },
          content: { type: "string", description: "The full new content of the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run",
      description: "Run a shell command in the repository root (tests, lint, typecheck, git status). No git push.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "One shell command line" } },
        required: ["command"],
      },
    },
  },
];

const cap = (text, limit = MAX_OUTPUT_CHARS) =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n... [truncated]`;

/** Resolves a root-relative path; null when the path escapes the root. */
function insideRoot(root, path) {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

async function toolResult(root, name, args) {
  switch (name) {
    case "list_files": {
      const abs = insideRoot(root, args.path ?? ".");
      if (!abs) return "Refused: path escapes the repository.";
      const files = [];
      try {
        walk(abs, files);
      } catch (error) {
        return `Error: ${error.message}`;
      }
      files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      return cap(files.map((f) => relative(root, f)).join("\n")) || "(empty)";
    }
    case "read_file": {
      const abs = insideRoot(root, args.path);
      if (!abs) return "Refused: path escapes the repository.";
      try {
        const lines = readFileSync(abs, "utf8").split(/\r?\n/);
        const offset = Math.max(1, args.offset ?? 1);
        const limit = args.limit ?? 400;
        return cap(lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}\t${line}`).join("\n"));
      } catch (error) {
        return `Error: ${error.message}`;
      }
    }
    case "grep": {
      const abs = insideRoot(root, args.path ?? ".");
      if (!abs) return "Refused: path escapes the repository.";
      let regex;
      try {
        regex = new RegExp(args.pattern);
      } catch (error) {
        return `Bad pattern: ${error.message}`;
      }
      const files = [];
      try {
        if (statSync(abs).isFile()) files.push(abs);
        else walk(abs, files);
      } catch (error) {
        return `Error: ${error.message}`;
      }
      const hits = [];
      for (const file of files) {
        for (const [i, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
          if (regex.test(line)) hits.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
          if (hits.length >= 200) return cap(hits.join("\n")) + "\n... [capped at 200 hits]";
        }
      }
      return cap(hits.join("\n")) || "(no matches)";
    }
    case "write_file": {
      const abs = insideRoot(root, args.path);
      if (!abs) return "Refused: path escapes the repository.";
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, String(args.content ?? ""));
        return `Wrote ${relative(root, abs)} (${String(args.content ?? "").length} chars).`;
      } catch (error) {
        return `Error: ${error.message}`;
      }
    }
    case "run": {
      const command = String(args.command ?? "").trim();
      if (/\bgit\s+push\b/.test(command)) return "Refused: the agent never pushes.";
      return new Promise((resolvePromise) => {
        exec(command, { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
          const parts = [
            `exit code: ${error ? (error.code ?? 1) : 0}`,
            cap(stdout ?? ""),
            stderr ? `stderr:\n${cap(stderr, 2000)}` : "",
          ];
          resolvePromise(parts.filter(Boolean).join("\n"));
        });
      });
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

async function chat(messages, { model, key, baseUrl }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools: TOOLS }),
  });
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return (await response.json()).choices[0].message;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();

  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
  };
  const model = flag("--model") ?? process.env.OMB_AGENT_MODEL?.trim() ?? DEFAULT_MODEL;
  const maxTurns = Number(flag("--max-turns") ?? 25);
  const task = argv.filter((a) => !a.startsWith("--")).join(" ");
  if (!task) {
    console.error('Usage: node agent/omb-agent.mjs "task..." [--model owner/model] [--max-turns 25]');
    return 1;
  }
  const key = process.env.OMB_OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    console.error("Set OMB_OPENROUTER_API_KEY or OPENROUTER_API_KEY.");
    return 1;
  }
  const baseUrl = (process.env.OMB_OPENROUTER_BASE_URL?.trim() || OPENROUTER_BASE).replace(/\/+$/, "");

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
  ];
  for (let turn = 1; turn <= maxTurns; turn++) {
    console.error(`[omb-agent] turn ${turn}/${maxTurns} (${model})`);
    let message;
    try {
      message = await chat(messages, { model, key, baseUrl });
    } catch (error) {
      console.error(`[omb-agent] ${error.message}`);
      return 1;
    }
    messages.push(message);
    const calls = message.tool_calls ?? [];
    if (!calls.length) {
      console.log(message.content ?? "(no content)");
      return 0;
    }
    for (const call of calls) {
      let args;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Error: arguments are not valid JSON." });
        continue;
      }
      console.error(`[omb-agent] ${call.function.name} ${JSON.stringify(args).slice(0, 120)}`);
      const result = await toolResult(REPO_ROOT, call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  console.error(`[omb-agent] stopped at the ${maxTurns}-turn budget.`);
  return 1;
}

/** Exercises every tool against a throwaway fixture directory; no network. */
async function selfTest() {
  const fixture = mkdtempSync(join(tmpdir(), "omb-agent-"));
  let all = true;
  const results = [];
  const check = (label, ok) => {
    results.push(`${ok ? "PASS" : "FAIL"} ${label}`);
    all = all && ok;
  };
  try {
    check(
      "write inside root",
      (await toolResult(fixture, "write_file", { path: "notes/hello.txt", content: "alpha\nbravo\ncharlie" })).startsWith("Wrote"),
    );
    check("read back", (await toolResult(fixture, "read_file", { path: "notes/hello.txt" })).includes("bravo"));
    check("grep finds", (await toolResult(fixture, "grep", { pattern: "bravo", path: "notes" })).includes("hello.txt:2"));
    check("list finds", (await toolResult(fixture, "list_files", { path: "notes" })).includes("hello.txt"));
    check("refuses escape", (await toolResult(fixture, "read_file", { path: "../outside.txt" })).startsWith("Refused"));
    check("refuses absolute outside", (await toolResult(fixture, "write_file", { path: join(tmpdir(), "evil.txt"), content: "x" })).startsWith("Refused"));
    check("refuses push", (await toolResult(fixture, "run", { command: "git push origin main" })).startsWith("Refused"));
    check(
      "run command",
      (await toolResult(fixture, "run", { command: "node -e \"console.log(21*2)\"" })).includes("42"),
    );
    check("run reports nonzero exit", (await toolResult(fixture, "run", { command: "node -e \"process.exit(3)\"" })).includes("exit code: 3"));
    console.log(results.join("\n"));
    return all ? 0 : 1;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code ?? 0), (error) => {
  console.error(error);
  process.exit(1);
});
