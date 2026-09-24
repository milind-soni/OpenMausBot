// OpenMausBot owns computer selection and mounts its scoped MCP servers.
// Keep the standalone Codex installation untouched: these overrides apply
// only to the child process, including resumed conversations and retries.
// The desktop-app browser is not available in Codex CLI. Enabling its tool
// without a desktop connection exposes an unusable route; native search is
// independent and must remain governed by the user's/provider's config.
// https://developers.openai.com/codex/browser
export function codexToolSurfaceArgs(): string[] {
  return [
    "-c", "features.browser_use=false",
    "-c", "features.browser_use_external=false",
    "-c", "features.computer_use=false",
    // Disable the matching instructions as well as the native tool. Use an
    // inline table: quoted dotted keys are interpreted literally by some CLIs.
    "-c", 'plugins={ "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }',
    // Native web search does not require the desktop browser connection.
    // Preserve the user's/provider's search mode instead of disabling it for
    // every OpenMausBot process after a failure in one search route.
  ];
}
