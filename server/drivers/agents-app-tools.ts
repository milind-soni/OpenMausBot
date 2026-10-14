export const APP_TOOL_DEFINITIONS = [
  {
    name: "show_html",
    description:
      "Show a small self-contained web page inline in this chat: an interactive mini app, a game, a chart or visualization, a calculator, a formatted report. For forms and choices use show_widget instead, and for plain data a markdown table. `html` is one HTML document (a fragment is wrapped) with inline style and script. It runs in a locked sandbox: no network requests (fetch, XHR and WebSockets fail), no cookies or storage, no popups, no form posts. Scripts, styles and fonts load only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com and Google Fonts; images must be inline data: URLs or come from those CDNs. Embed the data you need. The page sizes itself to its content, up to about 640px tall. Use the CSS variables --color-text-primary, --color-background-primary, --color-border-primary and --font-sans so it matches the person's theme. In the page, mausbot.send(text) sends text as the person's next message (only after they click in the page), mausbot.open(url) opens a link, and mausbot.setContext(text) tells you what the person is looking at, with their next message. At most 256 KB. Never put secrets in it. Not available in rooms.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        html: { type: "string", description: "One HTML document, or a fragment to wrap." },
        title: { type: "string", description: "A one-line title, at most 80 characters." },
        height: { type: "number", description: "Optional starting height in pixels, 80 to 720." },
        fallback_text: { type: "string", description: "Optional plain-text version for clients that cannot show pages. Written for you when omitted." },
      },
      required: ["html", "title"],
    },
  },
  {
    name: "update_html",
    description:
      "Replace a page you showed with show_html, in place. `app_id` is the id show_html returned. The page reloads, so anything the person did in it is lost.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        app_id: { type: "string" },
        html: { type: "string" },
        title: { type: "string" },
      },
      required: ["app_id", "html"],
    },
  },
];
