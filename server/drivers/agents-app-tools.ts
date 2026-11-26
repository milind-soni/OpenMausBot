export const APP_TOOL_DEFINITIONS = [
  {
    name: "show_html",
    description:
      "Show a small self-contained web page in this chat, where the person can point at a part to change: a mini app, a game, a chart, a calculator, a report. Forms and choices go in show_widget, plain data in a markdown table. Send `html` (a document or a fragment, with inline style and script), `jsx`, one React component file with a default export (it can import react, lucide-react icons, echarts, and Chart and useTheme from \"mausbot\", and style with Tailwind classes), or `path`, a folder in your working folder with index.html and its files (up to 5 MB). It runs in a locked sandbox: no network requests, storage, popups or form posts; scripts, styles and fonts load only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com and Google Fonts, images only as data: URLs or from those; embed the data. Theme: --color-text-primary, --color-background-primary, --color-border-primary, --font-sans. In the page, mausbot.send(text) puts text in their message box after they click in it, mausbot.open(url) opens a link, mausbot.setContext(text) tells you what they see. uses [\"data\"]: mausbot.data.query(sql) SELECTs your Data tables; \"state\": mausbot.state.get/set. At most 256 KB. Call again with its app_id to replace it; it reloads. Never put secrets in it. In rooms everyone sees it, view-only. For a data dashboard, follow the data-dashboards skill. Asked for a claude.ai Artifact? Those need Claude's own claude.ai sign-in and are not available to bots here: say so in one line, then make it with this tool, or publish_page for a public link.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        html: { type: "string" },
        jsx: { type: "string" },
        path: { type: "string", description: "A folder with index.html, or an .html file." },
        title: { type: "string", description: "One line, at most 80 characters; a new page needs one." },
        height: { type: "number", description: "Starting pixels, 80 to 720; give it for maps, canvases, games or a full window." },
        fallback_text: { type: "string", description: "Optional plain text for clients without pages." },
        frameless: { type: "boolean", description: "true drops the card frame; a replacement keeps its frame unless given." },
        live: { type: "boolean", description: "With path: true reloads it when its folder changes." },
        uses: { type: "array", items: { type: "string" } },
        app_id: { type: "string", description: "Only to replace a page you showed." },
      },
    },
  },
];
