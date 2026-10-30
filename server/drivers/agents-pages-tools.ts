// The agents catalog's page tools and the internal route behind each. Shown to every bot: a server signed in to no
// MausBot account answers with the sentence asking the person to sign in.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const PAGE_TOOL_ROUTES: Readonly<Record<string, string>> = { publish_page: "pages/publish", unpublish_page: "pages/unpublish" };
export const PAGE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(PAGE_TOOL_ROUTES));

export async function callPageTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(`/api/internal/${PAGE_TOOL_ROUTES[name]}`, { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "Done.") } : { text: String(body.error ?? "Publishing failed. Try again shortly."), isError: true };
}

const PAGE_ID = { type: "string", pattern: "^[a-z0-9]{20,63}$", description: "The page's id, the first part of its link." };

export const PAGE_TOOL_DEFINITIONS = [
  {
    name: "publish_page",
    description:
      "Publish a page you made to a public link, only when the person asks to share or publish it: an .html file, or a folder with an index.html (static files, csv and parquet data too, up to 5 MB). Publishing the same path again, or passing page_id, updates the same link. Never publish secrets or personal details the person didn't ask to share. For a data dashboard, follow the data-dashboards skill.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "The file or folder, in your working folder." },
        title: { type: "string", maxLength: 200, description: "A short name for the page." },
        page_id: PAGE_ID,
      },
      required: ["path", "title"],
    },
  },
  {
    name: "unpublish_page",
    description: "Take a published page down when the person asks; its link stops working. Pass page_id, or the path it was published from.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { page_id: PAGE_ID, path: { type: "string" } },
    },
  },
];
