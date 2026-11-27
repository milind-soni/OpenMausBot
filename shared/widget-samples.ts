// Model-shaped widget inputs, written the way a bot or ChatKit's Widget Builder
// writes them, using every node type between them. Tests, the phone fixtures
// and the verification recipe all read these.

const prRow = (number: number, title: string, detail: string, status: string, color: string) => ({
  type: "ListViewItem",
  gap: 3,
  onClickAction: { type: "pr.open", payload: { pr: number } },
  children: [
    { type: "Icon", name: "pull-request", color: "secondary" },
    { type: "Col", flex: 1, children: [{ type: "Text", value: title, weight: "medium", truncate: true }, { type: "Caption", value: detail, truncate: true }] },
    { type: "Badge", label: status, color, variant: "dot" },
  ],
});

const step = (name: string, done: boolean, when: string) => ({
  type: "Row",
  gap: 2,
  align: "center",
  children: [
    { type: "Icon", name: done ? "check" : "empty-circle", color: done ? "success" : "tertiary", size: "sm" },
    { type: "Text", value: name, size: "sm" },
    { type: "Spacer" },
    { type: "Caption", value: when, color: "tertiary" },
  ],
});

const field = (label: string, control: Record<string, unknown>) => ({
  type: "Row",
  align: "center",
  children: [{ type: "Label", value: label, fieldName: control.name }, { type: "Spacer" }, control],
});

const cells = (header: boolean, ...values: string[]) => ({
  type: "Table.Row",
  ...(header ? { header: true } : {}),
  children: values.map((value, index) => ({
    type: "Table.Cell",
    ...(index === values.length - 1 ? { align: "end" } : {}),
    children: [{ type: "Text", value, size: "sm", ...(header ? { color: "secondary" } : {}) }],
  })),
});

const dish = (value: string, title: string, detail: string, time: string) => ({
  type: "ListViewItem",
  value,
  children: [{ type: "Col", flex: 1, children: [{ type: "Text", value: title, weight: "medium" }, { type: "Caption", value: detail }] }, { type: "Caption", value: time, color: "tertiary" }],
});

export const WIDGET_SAMPLES: Record<string, unknown> = {
  // A list the person picks one row from: `name` makes its rows selectable.
  dinnerChoice: {
    type: "ListView",
    name: "dish",
    title: "Dinner tonight",
    caption: "Pick one and I'll plan the rest.",
    children: [
      dish("butter-chicken", "Butter chicken with naan", "Rich, creamy, classic comfort food", "45 min"),
      dish("veggie-bowl", "Grilled veggie bowl with quinoa", "Light, healthy, quick to prepare", "20 min"),
      dish("pizza", "Margherita pizza", "Easy, crowd-pleasing, order-in friendly", "Order in"),
    ],
    confirm: { label: "Pick this", action: { type: "dinner.pick" } },
    cancel: { label: "None of these", action: { type: "dinner.none" } },
  },

  pullRequests: {
    type: "ListView",
    title: "Pull requests",
    caption: "mausbot-mobile",
    meta: "3 open",
    children: [
      prRow(750, "iOS: mid-turn steer", "#750 · 4 files · passed 2h ago", "Ready", "success"),
      prRow(739, "Android: thread pin parity", "#739 · 2 files · passed 5h ago", "Ready", "success"),
      prRow(719, "iOS: file links, send, attach", "#719 · 9 files · 1 test failing", "Failing", "danger"),
    ],
    confirm: { label: "Merge the two ready", action: { type: "pr.merge", payload: { prs: [750, 739] } } },
    cancel: { label: "Fix #719 first", action: { type: "pr.fix", payload: { pr: 719 } } },
  },

  buildStatus: {
    type: "Card",
    title: "Build 25 to TestFlight",
    caption: "OpenMausMobile 1.4.0 (25)",
    status: { text: "Uploading", icon: "upload" },
    children: [
      { type: "Progress", value: 0.62, label: "about 40s left" },
      { type: "Divider", spacing: 3, flush: true },
      { type: "Col", gap: 2, children: [step("Archived", true, "9:41 PM"), step("Signed", true, "9:42 PM"), step("Uploading to App Store Connect", false, "now"), step("Processing", false, "waiting")] },
    ],
  },

  routineForm: {
    type: "Card",
    title: "New routine: release check",
    caption: "Scout proposes this. Change anything before you create it.",
    children: [
      field("Runs on", { type: "DayPicker", name: "days", defaultValue: "mon,tue,wed,thu,fri" }),
      { type: "Divider" },
      field("Starts", { type: "DatePicker", name: "starts", defaultValue: "2026-10-14", min: "2026-10-13", clearable: true }),
      { type: "Divider" },
      field("At", { type: "TimePicker", name: "at", defaultValue: "09:00", step: 15, required: true }),
      { type: "Divider" },
      field("Report to", { type: "Select", name: "report", placeholder: "Choose a channel", options: [{ label: "Discord · #releases", value: "discord:releases" }, { label: "This chat", value: "chat" }] }),
      { type: "Divider" },
      { type: "Checkbox", name: "stopOnRed", label: "Stop if any check is red", defaultChecked: true },
    ],
    confirm: { label: "Create routine", action: { type: "routine.create", payload: { name: "release-check" } } },
    cancel: { label: "Discard", action: { type: "routine.discard" } },
  },

  // what a bot shows for "help me book a call": every field labels itself
  bookCall: {
    type: "Card",
    title: "Book a call",
    caption: "Pick a slot and I'll send the invite.",
    children: [
      { type: "Row", gap: 3, wrap: "wrap", children: [
        { type: "DatePicker", name: "date", label: "Date", defaultValue: "2026-10-15", min: "2026-10-14", max: "2026-11-30", required: true },
        { type: "TimePicker", name: "time", label: "Time", defaultValue: "10:30", min: "09:00", max: "18:00", step: 15, required: true },
      ] },
      { type: "RadioGroup", name: "length", label: "Length", direction: "row", defaultValue: "30", options: [{ label: "15 min", value: "15" }, { label: "30 min", value: "30" }, { label: "45 min", value: "45" }, { label: "1 hour", value: "60" }] },
      { type: "Textarea", name: "note", label: "Note", placeholder: "Optional: what should we cover?", rows: 2 },
    ],
    confirm: { label: "Book call", action: { type: "call.book" } },
    cancel: { label: "Not now", action: { type: "call.cancel" } },
  },

  spendTable: {
    type: "Card",
    title: "Spend by bot",
    caption: "Last 7 days",
    meta: "$42.10",
    children: [{
      type: "Table",
      children: [cells(true, "Bot", "Runs", "Cost"), cells(false, "Scout", "38", "$21.40"), cells(false, "Chief of Staff", "7", "$9.85"), cells(false, "Kiwi", "52", "$6.35"), cells(false, "Jev", "11", "$4.50")],
    }],
  },

  tokenChart: {
    type: "Card",
    title: "Token spend",
    caption: "Last 7 days · all bots",
    meta: "$42.10",
    children: [
      {
        type: "Chart",
        height: 160,
        xAxis: "day",
        series: [{ type: "bar", dataKey: "opus", label: "Opus", stack: "spend" }, { type: "bar", dataKey: "sonnet", label: "Sonnet", stack: "spend" }],
        data: [
          { day: "Wed", opus: 4.1, sonnet: 1.9 }, { day: "Thu", opus: 5.6, sonnet: 2.2 }, { day: "Fri", opus: 9.4, sonnet: 2.4 }, { day: "Sat", opus: 4.9, sonnet: 2.1 },
          { day: "Sun", opus: 0, sonnet: 2.3 }, { day: "Mon", opus: 2.6, sonnet: 1.6 }, { day: "Tue", opus: 1.7, sonnet: 1.3 },
        ],
      },
      { type: "Caption", value: "Friday is the peak. The weekend ran on Sonnet only." },
    ],
  },

  emailDraft: {
    type: "Card",
    size: "md",
    children: [
      { type: "Row", gap: 3, children: [{ type: "Caption", value: "TO", width: 64, color: "tertiary", weight: "semibold" }, { type: "Text", value: "iOS testers (3)" }] },
      { type: "Divider", flush: true },
      { type: "Row", gap: 3, children: [{ type: "Caption", value: "SUBJECT", width: 64, color: "tertiary", weight: "semibold" }, { type: "Text", value: "Build 25 is on TestFlight", weight: "medium" }] },
      { type: "Divider", flush: true },
      { type: "Markdown", value: "Hi all,\n\nBuild 25 is ready to test. It adds **mid-turn steer** and tappable file links.\n\nReply here if anything looks off." },
    ],
    confirm: { label: "Send email", action: { type: "email.send" } },
    cancel: { label: "Discard", action: { type: "email.discard" } },
  },

  sources: {
    type: "ListView",
    title: "Sources",
    caption: "What Scout read for this answer",
    limit: 2,
    children: [
      { type: "ListViewItem", onClickAction: { type: "open_url", payload: { url: "https://developers.openai.com/api/docs/guides/chatkit-widgets" } }, children: [{ type: "Icon", name: "globe" }, { type: "Col", flex: 1, children: [{ type: "Text", value: "ChatKit widgets guide", weight: "medium" }, { type: "Caption", value: "developers.openai.com" }] }, { type: "Icon", name: "external-link", color: "tertiary" }] },
      { type: "ListViewItem", onClickAction: { type: "open_url", payload: { url: "https://widgets.chatkit.studio/gallery" } }, children: [{ type: "Icon", name: "globe" }, { type: "Col", flex: 1, children: [{ type: "Text", value: "Widget Builder gallery", weight: "medium" }, { type: "Caption", value: "widgets.chatkit.studio" }] }, { type: "Icon", name: "external-link", color: "tertiary" }] },
      { type: "ListViewItem", children: [{ type: "Icon", name: "document" }, { type: "Col", flex: 1, children: [{ type: "Text", value: "shared/wire.ts", weight: "medium" }, { type: "Caption", value: "OpenMausBot · this computer" }] }] },
    ],
  },

  // Everything the other samples leave out, in one card.
  kitchenSink: {
    type: "Card",
    title: "Kitchen sink",
    size: "lg",
    children: [
      { type: "Row", gap: 2, wrap: "wrap", children: [{ type: "Badge", label: "Success", color: "success" }, { type: "Badge", label: "Info", color: "info" }, { type: "Badge", label: "Discovery", color: "discovery" }, { type: "Badge", label: "Danger", color: "danger", variant: "outline" }, { type: "Badge", label: "Warning", color: "warning", variant: "solid" }, { type: "Badge", label: "Secondary" }] },
      { type: "Title", value: "Title xl", size: "xl" },
      { type: "Text", value: "Body text with a longer line that wraps onto a second line when the card is narrow.", maxLines: 2 },
      { type: "Caption", value: "A caption in secondary ink", size: "sm" },
      { type: "Box", padding: 4, radius: "lg", background: "surface-secondary", children: [{ type: "Text", value: "Inside a box", weight: "semibold" }, { type: "Caption", value: "with padding and a surface" }] },
      { type: "Image", src: "https://mausbot.com/og.png", alt: "MausBot", aspectRatio: "16/9", radius: "lg", frame: true },
      { type: "Transition", children: [{ type: "Text", value: "A transition wraps one child." }] },
      {
        type: "Form",
        gap: 3,
        onSubmitAction: { type: "feedback.send" },
        children: [
          { type: "Label", value: "How did the run go?", fieldName: "rating" },
          { type: "RadioGroup", name: "rating", direction: "row", required: true, options: [{ label: "Good", value: "good" }, { label: "Mixed", value: "mixed" }, { label: "Bad", value: "bad" }] },
          { type: "Input", name: "email", label: "Email", placeholder: "Optional: where Scout can reply" },
          { type: "Label", value: "Note", fieldName: "note" },
          { type: "Textarea", name: "note", placeholder: "Anything Scout should know?", rows: 3 },
          { type: "Row", gap: 2, children: [{ type: "Button", label: "Send feedback", submit: true, style: "primary" }, { type: "Button", label: "Open the docs", variant: "outline", iconEnd: "external-link", onClickAction: { type: "open_url", payload: { url: "https://mausbot.com/docs" } } }, { type: "Button", label: "Ask me later", variant: "ghost", onClickAction: { type: "feedback.later" } }] },
        ],
      },
    ],
  },
};
