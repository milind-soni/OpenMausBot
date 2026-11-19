// The Apps section of a Buddy's system prompt, plus `+app` tag parsing.
// Only added for drivers that mount the harness MCP proxy (agentsMcp) — a
// Buddy is never told about apps it can't call.
import { APP_CATALOG, findApp } from "./catalog.ts";
import { appStatus, type AppState } from "./status.ts";

const STATE_LABEL: Record<AppState, string> = {
  ready: "ready",
  needs_setup: "not set up",
  not_running: "not running",
  error: "unavailable",
};

/** App ids tagged as `+id` in the text (start of text or after whitespace/punctuation). */
export function taggedApps(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(^|[\s([{"'])\+([a-z][a-z0-9-]*)/gi)) {
    const app = findApp(match[2]);
    if (app) found.add(app.id);
  }
  return [...found];
}

export async function buildAppsPrompt(latestUserText: string): Promise<string> {
  if (!APP_CATALOG.length) return "";
  const lines = await Promise.all(
    APP_CATALOG.map(async (app) => {
      const status = await appStatus(app.id).catch(() => null);
      const state = status ? STATE_LABEL[status.state] : "unavailable";
      return `- ${app.name} (id: ${app.id}, ${state}): ${app.blurb} Good for: ${app.capabilities.join(", ")}.`;
    }),
  );
  const tagged = taggedApps(latestUserText).map((id) => findApp(id)!.name);
  return [
    "[Apps]",
    "The user's desktop apps you can operate with list_apps and use_app:",
    ...lines,
    "Rules: when a request needs one of these apps, call list_apps first to get its live status and actions.",
    "If the app is ready, use it with use_app.",
    "If it is not ready, don't attempt the task: tell the user it isn't set up and give them the setup steps from list_apps in plain words (they can also click Set up on the Apps screen).",
    "If more than one ready app could do the task and the user didn't tag one, ask which they want before starting.",
    "Users choose an app by tagging it like +edits; a tagged app wins without asking.",
    "Never claim you used an app unless use_app returned a successful result.",
    tagged.length ? `The user tagged: ${tagged.join(", ")}. Use ${tagged.length === 1 ? "that app" : "those apps"} for this request.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
