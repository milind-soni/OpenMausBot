export const APP_TOOL_DEFINITIONS = [
  {
    name: "show_html",
    description:
      "Show a small self-contained web page in this chat, where the person watches it appear and can point at a part to change: a mini app, a game, a chart, a calculator, a report. For forms and choices use show_widget instead, and for plain data a markdown table. Send `html`, one HTML document (a fragment is wrapped) with inline style and script, or `jsx`, one React component file with a default export: it can import react, lucide-react icons, echarts, and Chart and useTheme from \"mausbot\", and style with Tailwind classes. Or send `path`, a folder in your working folder with index.html and its files (scripts, data, csv or parquet, images; up to 5 MB). It runs in a locked sandbox: no network requests, cookies, storage, popups or form posts. Scripts, styles and fonts load only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com and Google Fonts; images must be data: URLs or come from those CDNs. Embed the data you need. Use the CSS variables --color-text-primary, --color-background-primary, --color-border-primary and --font-sans to match the person's theme. In the page, mausbot.send(text) sends text as the person's next message (only after they click in it), mausbot.open(url) opens a link, and mausbot.setContext(text) tells you what they see, with their next message. At most 256 KB. Never put secrets in it. Not available in rooms. For a data dashboard, follow the data-dashboards skill.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        html: { type: "string", description: "One HTML document, or a fragment to wrap." },
        jsx: { type: "string", description: "Instead of html: a React component file with a default export." },
        path: { type: "string", description: "Instead of html: a folder with index.html, or an .html file." },
        title: { type: "string", description: "A one-line title, at most 80 characters." },
        height: { type: "number", description: "Optional starting height in pixels, 80 to 720." },
        fallback_text: { type: "string", description: "Optional plain-text version for clients that cannot show pages. Written for you when omitted." },
      },
      required: ["title"],
    },
  },
  {
    name: "update_html",
    description:
      "Replace a page you showed with show_html, in place, with new `html`, `jsx` or `path`. `app_id` is the id show_html returned. The page reloads, so anything the person did in it is lost.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        app_id: { type: "string" },
        html: { type: "string" },
        jsx: { type: "string" },
        path: { type: "string" },
        title: { type: "string" },
      },
      required: ["app_id"],
    },
  },
];
