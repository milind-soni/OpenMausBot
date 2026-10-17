// The agents catalog's X and research tools (through treg) and the internal route behind each. Every call is paid, from
// the person's own treg balance or their Cloud plan's allowance, so a bot is shown these tools only when a treg key or a
// plan credential is held and its research switch is on; each route checks both again before it spends.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const RESEARCH_TOOL_ROUTES: Readonly<Record<string, string>> = {
  x_search: "x/search", x_user_posts: "x/user-posts", x_post: "x/post", x_profile: "x/profile",
  research_search: "research/search", research_endpoint: "research/endpoint", research_call: "research/call",
};
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(RESEARCH_TOOL_ROUTES));

export async function callResearchTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(`/api/internal/${RESEARCH_TOOL_ROUTES[name]}`, { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: JSON.stringify(body) } : { text: String(body.error ?? "Research failed. Try again shortly."), isError: true };
}

export const RESEARCH_TOOL_DEFINITIONS = [
  {
    name: "x_search",
    description:
      "Search posts on X (Twitter) without an X account. Each call is paid (the user's treg balance or Cloud plan), so write one well-filtered query instead of many broad ones. The query takes X operators: from:handle, to:handle, \"exact phrase\", since:YYYY-MM-DD, until:YYYY-MM-DD, min_faves:N, -filter:replies, lang:en, OR. Bare words are all required, so use a short phrase or OR between alternatives. Returns compact posts (link, author, time, text, likes, reposts, replies, quotes, views) and newestId. To monitor X, for example in a routine, keep newestId and pass it back as sinceId next time to get only newer posts. Read-only: you cannot post, like or reply.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512, description: "The X search query; operators allowed." },
        sort: { type: "string", enum: ["latest", "top"], description: "latest (default) or top." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many posts, 1-50. Default 20." },
        sinceId: { type: "string", pattern: "^\\d{1,25}$", description: "Only posts newer than this post id: a newestId from an earlier call." },
      },
      required: ["query"],
    },
  },
  {
    name: "x_user_posts",
    description:
      "Read an X account's recent posts, newest first (a paid call). Returns compact posts and newestId; pass newestId back as sinceId later to get only newer posts. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", minLength: 1, description: "The account: @handle, handle, or an x.com profile link." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many posts, 1-50. Default 20." },
        sinceId: { type: "string", pattern: "^\\d{1,25}$", description: "Only posts newer than this post id." },
        includeReplies: { type: "boolean", description: "Include the account's replies to others. Default false." },
      },
      required: ["handle"],
    },
  },
  {
    name: "x_post",
    description:
      "Read one X post from its link or id, and optionally the first page of up to 20 replies to it (a paid call). Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        post: { type: "string", minLength: 1, description: "An x.com or twitter.com post link, or the post id." },
        replies: { type: "boolean", description: "Also return replies to the post. Default false." },
      },
      required: ["post"],
    },
  },
  {
    name: "x_profile",
    description:
      "Look up an X account's profile: name, bio, followers, following, post count and verified status (a paid call). Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", minLength: 1, description: "The account: @handle, handle, or an x.com profile link." },
      },
      required: ["handle"],
    },
  },
  {
    name: "research_search",
    description:
      "Find a research endpoint for a job in treg's catalog: companies, people and work emails, funding, news, social and trend data, SEO, search results, scraping, generation and more. Describe the job, not a vendor. Returns endpoints with their params, an example and the estimated cost; then call one with research_call. Searching is free.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: { type: "string", minLength: 1, maxLength: 300, description: "What the research is for, such as \"work email of a person at a company\"." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "How many endpoints, 1-10. Default 5." },
      },
      required: ["job"],
    },
  },
  {
    name: "research_endpoint",
    description: "Read one research endpoint in full: its params, an example, its cost and how to check on an async task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", minLength: 1, maxLength: 200, description: "An endpoint id from research_search." } },
      required: ["id"],
    },
  },
  {
    name: "research_call",
    description:
      "Call a research endpoint by id and get the provider's answer and what it cost (a paid call). params are its query parameters for a GET endpoint, otherwise its JSON body; query adds a query string to a body endpoint. Follow the endpoint's params and example. An async task answers with how to check on it: call that with research_call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200, description: "The endpoint id." },
        params: { type: "object", additionalProperties: true, description: "The endpoint's parameters." },
        query: { type: "object", additionalProperties: true, description: "Query string for an endpoint that takes a JSON body." },
      },
      required: ["id"],
    },
  },
];
