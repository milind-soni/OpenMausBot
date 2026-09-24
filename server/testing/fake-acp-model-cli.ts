#!/usr/bin/env node
// Minimal read-only ACP catalog fixture. No prompt is accepted or run.
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message: any;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }) + "\n");
    } else if (message.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "fixture",
        models: { currentModelId: "gemini-new", availableModels: [
          { modelId: "gemini-new", name: "Gemini New" },
          { modelId: "gemini-fast", name: "Gemini Fast" },
        ] },
      } }) + "\n");
    }
  }
});
