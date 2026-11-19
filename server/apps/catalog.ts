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
  /** The app's own icon, bundled under public/apps/ (never hotlinked). */
  icon: string;
  transport: "local-mcp-http" | "local-mcp-sse";
  protocolVersion?: string;
  defaultEndpoint: string;
  auth: { kind: "bearer"; label: string; help: string } | { kind: "none"; help: string };
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
    icon: "/apps/edits.png",
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
      "Edits is sandboxed: it can only open files inside the user's Movies folder (~/Movies). If the clips are elsewhere, call request_approval before copying them into a folder under ~/Movies, then import the copies.",
      "Project changes may not show in the project list until the project is saved or closed. Check the open project with appState or previewVideoFrames instead.",
    ],
  },
  {
    id: "affinity",
    name: "Affinity",
    maker: "Canva",
    blurb: "Design graphics, edit photos and lay out pages. Buddies can automate tasks in Affinity and build reusable scripts for you.",
    capabilities: ["graphic design", "vector design", "photo editing", "page layout", "design automation", "Affinity scripts"],
    category: "design",
    icon: "/apps/affinity.png",
    transport: "local-mcp-sse",
    protocolVersion: "2025-11-25",
    defaultEndpoint: "http://[::1]:6767/sse",
    auth: { kind: "none", help: "No access token is needed. Affinity controls access through its own MCP settings." },
    setupSteps: [
      "Install the latest Affinity by Canva desktop app and open it.",
      "In Affinity, open Settings → Model Context Protocol and enable Affinity MCP.",
      "Quit and reopen Affinity after enabling MCP, then keep it open.",
      "Click Test connection here. No token is needed.",
    ],
    buddyNotes: [
      "Before running scripts, call read_sdk_documentation_topic with filename preamble, then read the relevant SDK topics. Keep scripts directly executable JavaScript and use console.log for output. After a connection reset or idle reconnect, read the preamble again.",
      "Use render_spread or render_selection to inspect your work visually. Inspect the current documents before editing; do not replace or save over unrelated user work.",
      "Affinity controls scripting, file, network, and AI permissions in its MCP settings. If a tool returns NOT_ALLOWED, explain which permission is needed; do not broaden permissions automatically.",
      "When filesystem access is permitted, Affinity can only access files on the Desktop. Use application.js userDesktopPath (or getUserDesktopPath on older versions) to locate it. Call request_approval before copying files from elsewhere, unless that copy is already authorized.",
      "Do not call report_sdk_issue, search_sdk_hints, or add_sdk_hint without explicit user permission: these may send scripts, queries, or hints outside this computer. Do not use paid Canva AI without authorization.",
      "Read execute_script output carefully: script errors can appear in text even when isError is false. After a timeout, inspect the document before retrying; the script may already have changed it.",
    ],
  },
];

export function findApp(id: string): AppDefinition | undefined {
  return APP_CATALOG.find((app) => app.id === id.toLowerCase());
}
