// Child-process-only overrides (the standalone Codex install stays untouched). The desktop-app browser is
// not available in Codex CLI, so its tool is off; native web search stays governed by the user's config.
// https://developers.openai.com/codex/browser
export function codexToolSurfaceArgs(): string[] {
  return [
    "-c", "features.browser_use=false",
    "-c", "features.browser_use_external=false",
    "-c", "features.computer_use=false",
    // Plugins the ChatGPT account installed reach every Codex home signed in to it (codex-cli 0.167.0): their skills join
    // the bot's list and `request_plugin_install` its tools, whatever the bot's own switches say.
    "-c", "features.plugins=false",
    // An inline table: some CLIs read quoted dotted keys literally.
    "-c", 'plugins={ "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }',
    // Native web search needs no desktop browser connection; keep the user's/provider's mode.
  ];
}
