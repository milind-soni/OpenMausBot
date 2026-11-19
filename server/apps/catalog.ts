// Curated apps — the short, hand-picked list on the Apps screen. Every entry
// must be settable-up by a non-technical user in about a minute: no developer
// accounts, no API consoles. Today that means desktop apps exposing a local
// MCP server (loopback HTTP + a token copied from the app's own settings).
//
// Adding an app = adding an entry here. Buddies discover apps and their tools
// at runtime (list_apps / use_app through the harness proxy), so no driver
// changes are needed.

export interface AppDefinition {
  /** Stable id; also the composer tag (`+edits`). Lowercase letters, digits, hyphens. */
  id: string;
  name: string;
  /** Who makes it, shown under the name. */
  maker: string;
  /** One plain sentence: what a Buddy can do with it. */
  blurb: string;
  /** Plain words Buddies match a request against ("make a montage" → montage). */
  capabilities: string[];
  category: "video" | "design" | "productivity" | "developer";
  transport: "local-mcp-http";
  defaultEndpoint: string;
  auth: { kind: "bearer"; label: string; help: string };
  /** Numbered, non-technical setup steps (shown in the popup and given to Buddies). */
  setupSteps: string[];
  /** Working rules for Buddies (in the prompt and list_apps), learned from real use. */
  buddyNotes: string[];
}

export const APP_CATALOG: readonly AppDefinition[] = [
  {
    id: "edits",
    name: "Edits",
    maker: "Instagram",
    blurb: "Instagram's video editor. Buddies can build and edit video projects in it for you, like montages from your clips.",
    capabilities: ["video editing", "montage", "clips", "reels", "short-form video", "captions"],
    category: "video",
    transport: "local-mcp-http",
    defaultEndpoint: "http://127.0.0.1:19501/mcp",
    auth: {
      kind: "bearer",
      label: "Access token",
      help: "In Edits: Settings → Automation → Access token → Copy.",
    },
    setupSteps: [
      "Install the Edits desktop app and open it.",
      "In Edits, open Settings and choose the Automation tab.",
      "Turn on “Enable Automation Server”.",
      "Under Access token, click Copy.",
      "Paste the token here, then click Test connection.",
    ],
    buddyNotes: [
      "Edits is sandboxed: it can only open files inside the user's Movies folder (~/Movies). If the clips are elsewhere, ask the user before copying them into a folder under ~/Movies, then import the copies.",
      "Project changes may not show in the project list until the project is saved or closed. Check the open project with appState or previewVideoFrames instead.",
    ],
  },
];

export function findApp(id: string): AppDefinition | undefined {
  return APP_CATALOG.find((app) => app.id === id.toLowerCase());
}
